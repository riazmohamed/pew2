import { describe, expect, it } from "bun:test";
import { readSecret, removeSecret, slotFor, writeSecret, type SecretStore } from "./keychainSlots";

/** A keychain with two classes: legacy items are unreadable while `locked`. */
function keychain(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const lockable = new Set<string>();
  const state = { locked: false, log: [] as string[] };
  const store: SecretStore = {
    async get(key) {
      if (state.locked && items.has(key) && !lockable.has(key))
        throw new Error("interaction not allowed");
      return items.get(key) ?? null;
    },
    async set(key, value) {
      state.log.push(`set ${key}`);
      items.set(key, value);
      lockable.add(key);
    },
    async remove(key) {
      state.log.push(`remove ${key}`);
      items.delete(key);
      lockable.delete(key);
    },
  };
  return { store, items, state };
}

describe("pairing secrets survive a locked launch", () => {
  it("a secret stored before the fix cannot be read while locked, and says so", async () => {
    // The silent call: the launch for a call is locked, and "not readable" was
    // taken as "not paired".
    const { store, state } = keychain({ pairing: "link" });
    state.locked = true;
    await expect(readSecret(store, "pairing")).rejects.toThrow();
  });

  it("moves to the lockable slot on the first unlocked read, copy before delete", async () => {
    const { store, items, state } = keychain({ pairing: "link" });
    expect(await readSecret(store, "pairing")).toBe("link");
    expect(state.log).toEqual([`set ${slotFor("pairing")}`, "remove pairing"]);
    expect(items.has("pairing")).toBe(false);
  });

  it("once moved, is readable while locked", async () => {
    const { store, state } = keychain({ pairing: "link" });
    await readSecret(store, "pairing");
    state.locked = true;
    expect(await readSecret(store, "pairing")).toBe("link");
  });

  it("a write goes straight to the lockable slot", async () => {
    const { store, state } = keychain({ pairing: "old" });
    await writeSecret(store, "pairing", "new");
    state.locked = true;
    expect(await readSecret(store, "pairing")).toBe("new");
  });

  it("an unpair removes both slots, so the old copy cannot come back", async () => {
    const { store, items } = keychain({ pairing: "old", [slotFor("pairing")]: "new" });
    await removeSecret(store, "pairing");
    expect(items.size).toBe(0);
    expect(await readSecret(store, "pairing")).toBeNull();
  });

  it("nothing stored reads as none, locked or not", async () => {
    const { store, state } = keychain();
    expect(await readSecret(store, "pairing")).toBeNull();
    state.locked = true;
    expect(await readSecret(store, "pairing")).toBeNull();
  });
});
