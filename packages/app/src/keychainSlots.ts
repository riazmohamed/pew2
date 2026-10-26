/**
 * Pairing secrets that can be read while the phone is locked.
 *
 * A call from Pew is a VoIP push, and iOS launches a closed app to take it
 * while the screen is still locked. The pairing link and the device id were
 * stored with the keychain's default class, readable only while unlocked, so
 * that launch could read neither: the app took itself to be unpaired, never
 * connected, and the answered call was silent. They now live under the
 * "after first unlock" class, readable once the phone has been unlocked a
 * single time since it booted, which is what any app that answers calls uses.
 *
 * iOS cannot change an existing item's class (an update rewrites the value
 * only), so each secret moves to a new slot, `<key>.afu`, the first time it is
 * read while unlocked: copied first, the old slot removed after. A crash in
 * between leaves both, and the new one is read from then on.
 *
 * Pure (the keychain is passed in), so the move can be tested under bun.
 */

/** The keychain calls this needs. `get` rejects when the item exists but cannot be read now. */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  /** Writes under the after-first-unlock class. */
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Where a secret lives now. `.` is one of the characters a keychain key may hold. */
export function slotFor(key: string): string {
  return `${key}.afu`;
}

/**
 * Read a secret, moving it to its lockable slot on the way.
 *
 * Rejects when either slot exists but cannot be read (the phone is locked and
 * the secret has not moved yet): the caller must not take that to mean "none".
 */
export async function readSecret(store: SecretStore, key: string): Promise<string | null> {
  const current = await store.get(slotFor(key));
  if (current !== null) return current;
  const legacy = await store.get(key);
  if (legacy === null) return null;
  await store.set(slotFor(key), legacy);
  // Best effort: if this fails, the new slot still wins every later read.
  await store.remove(key).catch(() => {});
  return legacy;
}

/** Write a secret to its lockable slot, and drop any copy left in the old one. */
export async function writeSecret(store: SecretStore, key: string, value: string): Promise<void> {
  await store.set(slotFor(key), value);
  await store.remove(key).catch(() => {});
}

/** Remove a secret from both slots, so an unpair cannot be undone by the copy left behind. */
export async function removeSecret(store: SecretStore, key: string): Promise<void> {
  await Promise.all([store.remove(slotFor(key)), store.remove(key)]);
}
