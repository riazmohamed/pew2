import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushRegistry } from "./push.js";
import { persistPushTargets, pushTargetsPath, readPushTargets } from "./push-store.js";

const TOKEN = "ExponentPushToken[abc]";
const PAIRING = "a".repeat(43);

async function home(): Promise<NodeJS.ProcessEnv> {
  return { PEW2_HOME: await mkdtemp(join(tmpdir(), "pew2-push-")) };
}

describe("push targets on disk", () => {
  it("survive a restart, so a phone in a pocket still hears about finished turns", async () => {
    const env = await home();
    const before = new PushRegistry();
    const settled = persistPushTargets(before, () => PAIRING, env);
    before.register("phone", TOKEN, "ios");
    await settled();

    const after = new PushRegistry();
    after.restore(await readPushTargets(PAIRING, env));
    expect(after.list()).toEqual([{ token: TOKEN, platform: "ios" }]);
  });

  it("are forgotten by a rotation, so a phone cut off stops getting banners", async () => {
    const env = await home();
    const registry = new PushRegistry();
    const settled = persistPushTargets(registry, () => PAIRING, env);
    registry.register("phone", TOKEN, "ios");
    await settled();
    expect((await readPushTargets("b".repeat(43), env)).targets).toEqual({});
  });

  it("keep a forgotten token forgotten", async () => {
    const env = await home();
    const registry = new PushRegistry();
    const settled = persistPushTargets(registry, () => PAIRING, env);
    registry.register("phone", TOKEN, "ios");
    registry.forget(TOKEN);
    await settled();
    expect((await readPushTargets(PAIRING, env)).targets).toEqual({});
  });

  it("never write the pairing token itself, and are owner-only", async () => {
    // The token is what the LAN socket checks; copying it is copying a credential.
    const env = await home();
    const registry = new PushRegistry();
    const settled = persistPushTargets(registry, () => PAIRING, env);
    registry.register("phone", TOKEN, "ios");
    await settled();
    const path = pushTargetsPath(env);
    expect(await readFile(path, "utf8")).not.toContain(PAIRING);
    // Windows has no POSIX mode bits to assert on (as in `goalFiles.test.ts`).
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o077).toBe(0);
  });

  it("read a missing or corrupt file as no phones", async () => {
    const env = await home();
    expect(await readPushTargets(PAIRING, env)).toEqual({ targets: {}, voip: {} });
  });
});
