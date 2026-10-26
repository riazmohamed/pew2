/**
 * Pairing storage on the phone.
 *
 * The token is a bearer secret — anyone holding it can drive every agent on the
 * paired machine — so it lives in the keychain, not in plain app storage.
 * Validation lives in `pairingLink.ts`, which stays pure so it can be tested.
 */
import * as SecureStore from "expo-secure-store";
import { getRandomValues } from "expo-crypto";
import { parsePairing, type Pairing } from "./pairingLink";
import { readSecret, removeSecret, writeSecret, type SecretStore } from "./keychainSlots";

export { parsePairing, type Pairing, type ParseResult } from "./pairingLink";

const KEY = "pew2.pairing";
const DEVICE_KEY = "pew2.deviceId";

/**
 * The keychain, with secrets written under "after first unlock" so the launch
 * iOS makes for a call on a locked phone can still read them (`keychainSlots.ts`).
 * Readable while locked, once unlocked since boot; still never leaves the
 * keychain, and still moves with an encrypted backup exactly as before.
 */
const keychain: SecretStore = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) =>
    SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
  remove: (key) => SecureStore.deleteItemAsync(key),
};

/**
 * The stored pairing exists but cannot be read right now: the phone is locked
 * and the pairing predates the after-first-unlock slot. Not "unpaired": the
 * caller tries again once the app is in front of an unlocked phone.
 */
export class PairingUnavailableError extends Error {
  constructor(cause: unknown) {
    super("The stored pairing cannot be read while the phone is locked.", { cause });
    this.name = "PairingUnavailableError";
  }
}

/**
 * This install's id from the keychain, minted on first use. Rejects when the
 * keychain cannot be read, rather than inventing one: a pairing loaded with a
 * made-up id is refused by the daemon as a stranger's.
 */
async function storedDeviceId(): Promise<string> {
  const existing = await readSecret(keychain, DEVICE_KEY);
  if (existing) return existing;
  const bytes = getRandomValues(new Uint8Array(16));
  const minted = `phone-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  await writeSecret(keychain, DEVICE_KEY, minted);
  return minted;
}

/**
 * A stable id for this install.
 *
 * The relay uses it to tell devices apart, and it must survive restarts: a new
 * id on every launch would make one phone look like an endless stream of
 * different devices.
 *
 * Also what the daemon binds a pairing to. A pairing link admits one device,
 * and this id is how the daemon recognises it on every later connection — so it
 * is drawn from the system CSPRNG rather than `Math.random`, whose output is
 * predictable from a handful of samples. Someone holding a leaked link is
 * refused only for as long as they cannot guess the id that claimed it.
 */
export async function deviceId(): Promise<string> {
  try {
    return await storedDeviceId();
  } catch {
    // Without storage the id cannot persist, and a fixed fallback would be a
    // shared identity every install could claim under. Random keeps the pairing
    // gate meaningful; the cost is re-pairing after a restart, which is the
    // safer of the two failures.
    const bytes = getRandomValues(new Uint8Array(16));
    return `phone-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
}

/**
 * Read the stored pairing.
 *
 * Re-validated on the way out rather than trusted: a value written by an older
 * build, or corrupted, must not reach the socket layer where the failure would
 * appear as an unexplained blank screen.
 *
 * Rejects with {@link PairingUnavailableError} when the keychain is locked:
 * that is not "unpaired", and treating it so left a call answered on the lock
 * screen with nothing on the other end (and the pairing screen behind it).
 */
export async function loadPairing(): Promise<Pairing | null> {
  // Development only: `EXPO_PUBLIC_DEV_PAIRING=<link> npx expo start` pairs a
  // simulator with a local daemon without anyone pasting into it. Stripped
  // from release bundles by the `__DEV__` gate, and saved like a real pairing
  // so it survives reloads.
  const devLink = __DEV__ ? process.env.EXPO_PUBLIC_DEV_PAIRING : undefined;
  if (devLink) {
    try {
      const parsed = parsePairing(devLink, await deviceId());
      if (parsed.ok) {
        await savePairing(parsed.pairing).catch(() => {});
        return parsed.pairing;
      }
    } catch {
      // Fall through to the stored pairing.
    }
  }
  try {
    // Both reads at once. They are independent keys, and this sits directly on
    // the launch path: run in sequence, the app waited out two round trips to
    // the keychain — with the splash held over both — before it could decide
    // which screen to show. Asking for the device id even when nothing is
    // stored costs a first-launch mint that the pairing screen would trigger
    // moments later anyway, so the id is simply ready sooner.
    const [stored, id] = await Promise.all([readSecret(keychain, KEY), storedDeviceId()]);
    if (!stored) return null;
    // Stored with its fragment intact, because `parsePairing` strips the key out
    // of the URL it returns — keeping only that would lose the key on the first
    // reload, and the app would greet a paired user with the pairing screen.
    const parsed = parsePairing(stored, id);
    return parsed.ok ? parsed.pairing : null;
  } catch (error) {
    throw new PairingUnavailableError(error);
  }
}

export async function savePairing(pairing: Pairing): Promise<void> {
  // The link is re-parsed on load, so what is written has to be a *complete*
  // link — including the fragment carrying the key, which `parsePairing`
  // deliberately removes from `pairing.url` so it can never reach the wire.
  const complete = `${pairing.url}#k=${base64UrlFromHex(pairing.key)}`;
  await writeSecret(keychain, KEY, complete);
}

/** hex -> base64url, the form the fragment uses. */
function base64UrlFromHex(hex: string): string {
  let binary = "";
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Forget the daemon. Used by "Unpair", and after the token is rotated. */
export async function clearPairing(): Promise<void> {
  await removeSecret(keychain, KEY);
}
