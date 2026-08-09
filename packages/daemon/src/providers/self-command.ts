/**
 * Letting a manifest spawn the pew2 that is already running.
 *
 * Some agents do not speak ACP, and pew2 ships a bridge for them. A bridge is
 * source in this repo, which is fine from a checkout and impossible from the
 * shipped binary: there is no `.ts` file on disk to point a manifest at. Naming
 * an npm package instead would put a network fetch in front of a local agent.
 *
 * So the bridge travels *inside* the executable, reachable as a hidden
 * subcommand, and a manifest asks for it with the `${PEW2_SELF}` placeholder:
 *
 * ```json
 * { "distribution": { "type": "command",
 *                     "command": "${PEW2_SELF}",
 *                     "args": ["__bridge", "ogcoder"] } }
 * ```
 *
 * The substitution has to happen at spawn time rather than being baked into the
 * JSON, because the answer differs per install: a compiled binary is one
 * executable, while a checkout is `bun run <entrypoint>` — two argv entries, not
 * one. That is the whole reason this is a function and not a constant.
 */
import { fileURLToPath } from "node:url";

/** The placeholder a manifest uses to mean "whatever pew2 is running now". */
export const SELF_PLACEHOLDER = "${PEW2_SELF}";

/** A command plus the arguments that must precede the manifest's own. */
export interface SelfCommand {
  command: string;
  /** Empty for a compiled binary; the entrypoint when running from source. */
  prefixArgs: string[];
}

export interface SelfOptions {
  /** The running executable. `bun` from a checkout, pew2 itself when compiled. */
  execPath?: string;
  /** This module's own URL, which reveals whether we are inside a binary. */
  moduleUrl?: string;
  /** Resolves the CLI entrypoint from source. Injected for testing. */
  entrypoint?: () => string;
}

/**
 * Whether this code is running from inside a compiled Bun executable.
 *
 * Bun serves embedded files from a virtual root (`/$bunfs/...`, and `B:/~BUN/`
 * on Windows), so a module URL pointing there means the source is not on disk
 * and `process.execPath` is pew2 itself rather than the Bun runtime.
 */
export function isCompiled(moduleUrl: string): boolean {
  const path = moduleUrl.startsWith("file://") ? fileURLToPath(moduleUrl) : moduleUrl;
  return path.includes("/$bunfs/") || path.includes("$bunfs") || /^B:[\\/]~BUN/i.test(path);
}

/** The CLI entrypoint on disk, for the from-source case. */
function cliEntrypoint(): string {
  return fileURLToPath(new URL("../cli/index.ts", import.meta.url));
}

/**
 * How to invoke this pew2 again as a child process.
 *
 * Compiled, that is the executable alone. From a checkout it is the Bun runtime
 * plus the CLI entrypoint — spawning `process.execPath` on its own there would
 * start a bare Bun REPL, which hangs the handshake instead of failing.
 */
export function selfCommand(options: SelfOptions = {}): SelfCommand {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const execPath = options.execPath ?? process.execPath;
  if (isCompiled(moduleUrl)) return { command: execPath, prefixArgs: [] };
  return { command: execPath, prefixArgs: ["run", (options.entrypoint ?? cliEntrypoint)()] };
}

/**
 * Resolve a manifest's command and args, expanding `${PEW2_SELF}` if present.
 *
 * Manifests that name a real binary are returned untouched, so this is safe to
 * call on every spawn.
 */
export function resolveSelfCommand(
  command: string,
  args: readonly string[],
  options: SelfOptions = {},
): { command: string; args: string[] } {
  if (command !== SELF_PLACEHOLDER) return { command, args: [...args] };
  const self = selfCommand(options);
  return { command: self.command, args: [...self.prefixArgs, ...args] };
}
