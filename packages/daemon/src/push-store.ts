/**
 * Where to push, remembered across restarts.
 *
 * The registry used to live in memory alone, because the app re-registers on
 * every connect. That holds only while the phone keeps connecting, and a phone
 * in a pocket does not: after any restart — a self-update, a crash, the machine
 * rebooting — the daemon knew no phone at all, and every finished turn and
 * every approval went unannounced until someone opened the app by hand to find
 * out why it had gone quiet.
 *
 * Tied to the pairing rather than kept for ever. Rotating is how a phone stops
 * belonging to this machine, and a token surviving that would keep banners
 * (project names, the agent's opening line) going to a phone that was meant to
 * be cut off. The file names the pairing it was written under, as a hash —
 * the token itself is what the LAN socket checks, so it is not copied anywhere
 * else — and a file from another pairing reads as empty.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-file.js";
import type { PushRegistry, PushSnapshot } from "./push.js";
import { userProvidersDir } from "./providers/registry.js";

export function pushTargetsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(userProvidersDir(env)), "push-targets.json");
}

/** Which pairing a file belongs to, without writing the pairing token down. */
function pairingTag(pairingToken: string): string {
  return createHash("sha256").update(`pew2-push:${pairingToken}`).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Only entries that are at least the right shape. The registry then applies
 * the same token checks a live registration gets (`PushRegistry.restore`).
 */
function entries<T>(
  value: unknown,
  keep: (entry: Record<string, unknown>) => T | undefined,
): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isRecord(value)) return out;
  for (const deviceId of Object.keys(value).sort()) {
    const entry = value[deviceId];
    if (!isRecord(entry)) continue;
    const kept = keep(entry);
    if (kept !== undefined) out[deviceId] = kept;
  }
  return out;
}

/**
 * The phones stored for this pairing.
 *
 * Missing, corrupt, or written under another pairing all read as "none", never
 * as an error: the cost of not knowing a phone is the behaviour this replaced,
 * and the daemon must start regardless.
 */
export async function readPushTargets(
  pairingToken: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PushSnapshot> {
  const empty: PushSnapshot = { targets: {}, voip: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(pushTargetsPath(env), "utf8"));
  } catch {
    return empty;
  }
  if (!isRecord(parsed) || parsed.pairing !== pairingTag(pairingToken)) return empty;
  return {
    targets: entries(parsed.targets, ({ token, platform }) =>
      typeof token === "string" && (platform === "ios" || platform === "android")
        ? { token, platform }
        : undefined,
    ),
    voip: entries(parsed.voip, ({ token, env: apns }) =>
      typeof token === "string" && (apns === "sandbox" || apns === "production")
        ? { token, env: apns }
        : undefined,
    ),
  };
}

/** Replace the stored phones with `snapshot`, under this pairing. Owner-only. */
export async function writePushTargets(
  pairingToken: string,
  snapshot: PushSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = pushTargetsPath(env);
  await mkdir(dirname(path), { recursive: true });
  const document = { pairing: pairingTag(pairingToken), ...snapshot };
  await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`);
}

/**
 * Write the registry down whenever it changes, one write at a time.
 *
 * Whole-file rather than read-modify-write, unlike the prefs files: forgetting
 * a dead token has to stick, and merging with what is on disk would bring it
 * straight back. Writes are chained so they land in order, and each takes its
 * snapshot when it runs, so the last one to finish is always the latest state.
 *
 * @param pairingToken Read at write time: a rotation changes it while the
 *   daemon runs, and the write that clears the old phones must be filed under
 *   the new pairing.
 */
export function persistPushTargets(
  registry: PushRegistry,
  pairingToken: () => string,
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.error,
): () => Promise<void> {
  let writing = Promise.resolve();
  registry.onChange = () => {
    writing = writing
      .then(() => writePushTargets(pairingToken(), registry.snapshot(), env))
      .catch((error: unknown) => log(`[push] could not save push targets: ${String(error)}`));
  };
  // For tests and shutdown: resolves once every write so far has landed.
  return () => writing;
}
