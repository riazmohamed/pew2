/**
 * Where the conversation index actually lives on this device.
 *
 * Split from `sessionCache.ts` because of what importing Expo costs: the
 * daemon's own test suite imports app sources directly, so an SDK import
 * anywhere reachable from `useDaemon.ts` drags React Native's globals into a
 * Node typecheck and breaks it. The rules stay portable and tested; this file
 * is the platform half, wired in from `App.tsx` — the same seam `pushAddress`
 * uses.
 *
 * A file rather than SecureStore, which holds the pairing next door. SecureStore
 * is backed by the keychain and is sized for secrets: Android warns past two
 * kilobytes and can refuse a value outright, and this index is tens of them.
 * Nothing here is a secret in the first place — it is titles and paths, already
 * readable on the desktop that produced them — and it sits in this app's own
 * sandboxed documents directory, which is removed with the app.
 *
 * Every function is best effort and never throws. A cache that cannot be read
 * is an empty drawer until the daemon answers, which is exactly where the app
 * was before this existed; a cache that cannot be written costs the next launch
 * the same. Neither is worth failing a launch over.
 */
import { File, Paths } from "expo-file-system";

import {
  fromCachedSessions,
  type CachedSession,
  type SessionCacheFile,
} from "./sessionCache";
import type { Session } from "./useDaemon";

const FILE = "sessions.json";

function cacheFile(): File {
  return new File(Paths.document, FILE);
}

/**
 * The conversations remembered from the last run, newest first.
 *
 * Synchronous, and called from the `useState` initialiser rather than an
 * effect. An async read would render the drawer empty first and fill it a tick
 * later, which is the "my history is gone" flash this whole change exists to
 * remove. Reading a few tens of kilobytes off local storage is well under a
 * frame, and the app has nothing to show until it is done anyway.
 */
export function readSessionCache(): Session[] {
  try {
    const file = cacheFile();
    if (!file.exists) return [];
    return fromCachedSessions(JSON.parse(file.textSync()));
  } catch {
    // A truncated write, a format this build does not understand, or a
    // documents directory a test harness never created.
    return [];
  }
}

/** Replace the stored index. Best effort; never throws. */
export function writeSessionCache(sessions: CachedSession[]): void {
  try {
    const payload: SessionCacheFile = { version: 1, sessions };
    const file = cacheFile();
    // Overwritten whole, like `crashLog`: this is a snapshot of the current
    // list, and merging into a previous one would resurrect conversations the
    // agent has since forgotten.
    file.create({ overwrite: true });
    file.write(JSON.stringify(payload));
  } catch {
    // The next launch starts from the daemon, as it always used to.
  }
}

/**
 * Forget everything, for unpairing.
 *
 * Titles are user content and they came from a machine this phone is being
 * disconnected from, so "Forget" has to mean it. Leaving them would show the
 * previous owner's work on the pairing screen of the next one.
 */
export function clearSessionCache(): void {
  try {
    const file = cacheFile();
    if (file.exists) file.delete();
  } catch {
    // Nothing useful to do, and nothing to tell the user who is mid-unpair.
  }
}
