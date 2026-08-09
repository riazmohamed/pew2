/**
 * The model list GG Coder would show, read from GG Coder itself.
 *
 * `--rpc` accepts `switch_model` but offers no way to *enumerate* models, so the
 * bridge has to get the catalogue from somewhere. Hardcoding it would be wrong
 * within a release: the fork ships its own registry and adds models faster than
 * pew2 could follow, and a stale list means the phone offers a model the agent
 * will reject.
 *
 * So the registry is imported from the installed package. That is why the
 * resolution below is fussier than a `require`: the binary may be a symlink
 * (npm), a generated shell shim naming an absolute path (pnpm), or a checkout.
 *
 * Every failure here is soft. A missing registry means no model selector, which
 * is a diminished session; a thrown error means no session at all.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One entry of GG Coder's own `MODELS` array, narrowed to what we display. */
interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

/** An ACP `select` config option, as the phone's picker renders it. */
export interface ConfigOption {
  id: string;
  name: string;
  category: string;
  type: "select";
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}

/**
 * The `dist/cli.js` a GG Coder binary ultimately runs.
 *
 * pnpm writes a shell shim that `exec`s node against an absolute path, and the
 * `$basedir` it uses is the shim's own directory — so the path is resolved
 * against that, not against the current working directory.
 */
function entrypointFor(bin: string): string | undefined {
  let real: string;
  try {
    real = realpathSync(bin);
  } catch {
    return undefined;
  }
  // An npm-style symlink already points at the entrypoint.
  if (real.endsWith(".js")) return real;

  let text: string;
  try {
    text = readFileSync(real, "utf8");
  } catch {
    return undefined;
  }
  const match = /([^\s"']*cli\.js)/.exec(text);
  if (!match?.[1]) return undefined;
  return match[1].replace(/\$basedir/g, dirname(real));
}

/**
 * Providers this machine is actually logged into.
 *
 * Offering every model in the registry would list four providers the user has
 * no credentials for, and picking one fails at the next prompt rather than at
 * the moment of choosing. An unreadable auth file means "filter nothing" — a
 * slightly long list beats an empty one.
 */
function loggedInProviders(home: string): Set<string> | undefined {
  try {
    const raw = readFileSync(join(home, ".gg", "auth.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    return keys.length > 0 ? new Set(keys) : undefined;
  } catch {
    return undefined;
  }
}

export interface ModelOptionsInput {
  bin: string;
  /** What the child reported it is running, so the picker opens on the truth. */
  currentModel?: string;
  home?: string;
}

/**
 * Build the `model` config option, or `undefined` if the catalogue is unreadable.
 */
export async function modelConfigOption(
  input: ModelOptionsInput,
): Promise<ConfigOption | undefined> {
  const entrypoint = entrypointFor(input.bin);
  if (!entrypoint) return undefined;

  let models: ModelInfo[];
  try {
    const registry = (await import(join(dirname(entrypoint), "core", "model-registry.js"))) as {
      MODELS?: ModelInfo[];
    };
    if (!Array.isArray(registry.MODELS)) return undefined;
    models = registry.MODELS;
  } catch {
    return undefined;
  }

  const authed = loggedInProviders(input.home ?? homedir());
  const usable = authed ? models.filter((model) => authed.has(model.provider)) : models;
  if (usable.length === 0) return undefined;

  // The running model may be one the filter excluded — a stale config, or a
  // provider whose credentials were removed. Keeping it means the picker opens
  // on what is actually in use instead of silently showing someone else's model.
  const current =
    input.currentModel && usable.some((model) => model.id === input.currentModel)
      ? input.currentModel
      : (usable[0]?.id ?? "");

  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: current,
    options: usable.map((model) => ({
      value: model.id,
      name: model.name,
      description: model.provider,
    })),
  };
}

/**
 * The provider that owns a model id, needed because `switch_model` takes both.
 */
export async function providerForModel(
  bin: string,
  modelId: string,
): Promise<string | undefined> {
  const entrypoint = entrypointFor(bin);
  if (!entrypoint) return undefined;
  try {
    const registry = (await import(join(dirname(entrypoint), "core", "model-registry.js"))) as {
      MODELS?: ModelInfo[];
    };
    return registry.MODELS?.find((model) => model.id === modelId)?.provider;
  } catch {
    return undefined;
  }
}
