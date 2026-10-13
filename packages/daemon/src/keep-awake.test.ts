import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVITY_WINDOW_MS,
  KeepAwake,
  awakePlatform,
  holdReason,
  readKeepAwakeEnabled,
  writeKeepAwakeEnabled,
  type AwakeChild,
  type KeepAwakeStatus,
} from "./keep-awake.js";

const base = { enabled: true, supported: true, working: false, permissionPending: false, now: 1_000_000 };

test("policy: holds only when enabled, supported and in use", () => {
  expect(holdReason(base)).toBeUndefined();
  expect(holdReason({ ...base, working: true })).toBe("agent working");
  expect(holdReason({ ...base, permissionPending: true })).toBe("permission pending");
  expect(holdReason({ ...base, lastClientAt: base.now - ACTIVITY_WINDOW_MS + 1 })).toBe("client active");
  expect(holdReason({ ...base, lastClientAt: base.now - ACTIVITY_WINDOW_MS })).toBeUndefined();
  expect(holdReason({ ...base, working: true, enabled: false })).toBeUndefined();
  expect(holdReason({ ...base, working: true, supported: false })).toBeUndefined();
});

test("platforms: caffeinate tied to the daemon pid; linux needs systemd-inhibit; windows unsupported", () => {
  expect(awakePlatform("darwin", 42)).toEqual({
    supported: true,
    command: "/usr/bin/caffeinate",
    args: ["-i", "-w", "42"],
  });
  const linux = awakePlatform("linux", 42, () => "/usr/bin/systemd-inhibit");
  expect(linux.supported && linux.args).toContain("--what=idle");
  expect(awakePlatform("linux", 42, () => undefined).supported).toBe(false);
  const win = awakePlatform("win32", 42);
  expect(win.supported).toBe(false);
  expect(!win.supported && win.reason).toContain("Windows");
});

class FakeChild implements AwakeChild {
  killed = false;
  listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  on(event: string, listener: (...a: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  kill() {
    this.killed = true;
    return true;
  }
  emit(event: string, ...args: unknown[]) {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

function controller(options: { enabled?: boolean } = {}) {
  const state = { working: false, permissionPending: false, lastClientAt: undefined as number | undefined };
  const children: FakeChild[] = [];
  const spawned: string[][] = [];
  const changes: KeepAwakeStatus[] = [];
  const logs: string[] = [];
  let enabled = options.enabled ?? true;
  const awake = new KeepAwake({
    platform: { supported: true, command: "/usr/bin/caffeinate", args: ["-i", "-w", "1"] },
    state: () => state,
    readEnabled: async () => enabled,
    writeEnabled: async (value) => {
      enabled = value;
    },
    onChange: (status) => changes.push(status),
    spawn: (command, args) => {
      spawned.push([command, ...args]);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    now: () => 1_000_000,
    log: (m) => logs.push(m),
  });
  return { awake, state, children, spawned, changes, logs, setPref: (v: boolean) => (enabled = v) };
}

test("controller holds on work, releases after, and announces only real changes", () => {
  const c = controller();
  c.state.working = true;
  // Inert until started: a Daemon built in a test must never spawn caffeinate.
  c.awake.evaluate();
  expect(c.spawned).toEqual([]);
  void c.awake.start();
  c.state.working = false;
  c.awake.evaluate();
  expect(c.spawned).toEqual([]);
  expect(c.changes).toEqual([]);

  c.state.working = true;
  c.awake.evaluate();
  c.awake.evaluate();
  expect(c.spawned).toEqual([["/usr/bin/caffeinate", "-i", "-w", "1"]]);
  expect(c.children[0]!.listeners.has("error")).toBe(true);
  expect(c.children[0]!.listeners.has("spawn")).toBe(true);
  expect(c.changes).toEqual([{ supported: true, enabled: true, active: true }]);
  expect(c.logs).toEqual(["[awake] holding (agent working)"]);

  c.state.working = false;
  c.awake.evaluate();
  expect(c.children[0]!.killed).toBe(true);
  expect(c.changes.at(-1)).toEqual({ supported: true, enabled: true, active: false });
  expect(c.logs.at(-1)).toBe("[awake] released");
  c.awake.stop();
});

test("turning it off releases at once; the pref is re-read on each tick", async () => {
  const c = controller();
  c.state.lastClientAt = 1_000_000;
  await c.awake.start();
  expect(c.awake.status.active).toBe(true);

  await c.awake.setEnabled(false);
  expect(c.children[0]!.killed).toBe(true);
  expect(c.awake.status).toEqual({ supported: true, enabled: false, active: false });

  c.setPref(true);
  await c.awake.tick();
  expect(c.awake.status.active).toBe(true);
  c.awake.stop();
  expect(c.children[1]!.killed).toBe(true);
});

test("a child that fails or dies is forgotten, and the next evaluation holds again", async () => {
  const c = controller();
  c.state.working = true;
  await c.awake.start();
  c.children[0]!.emit("error", new Error("ENOENT"));
  expect(c.awake.status.active).toBe(false);
  c.awake.evaluate();
  expect(c.spawned).toHaveLength(2);
  c.children[1]!.emit("exit", 0);
  expect(c.awake.status.active).toBe(false);
  c.awake.stop();
});

test("unsupported platform never spawns and says why", () => {
  const awake = new KeepAwake({
    platform: { supported: false, reason: "nope" },
    state: () => ({ working: true, permissionPending: false }),
    readEnabled: async () => true,
    writeEnabled: async () => {},
    spawn: () => {
      throw new Error("must not spawn");
    },
  });
  void awake.start();
  awake.stop();
  expect(awake.status).toEqual({ supported: false, enabled: true, active: false, reason: "nope" });
});

test("pref file defaults on and round-trips", async () => {
  const env = { ...process.env, PEW2_HOME: mkdtempSync(join(tmpdir(), "pew2-awake-")) };
  expect(await readKeepAwakeEnabled(env)).toBe(true);
  await writeKeepAwakeEnabled(false, env);
  expect(await readKeepAwakeEnabled(env)).toBe(false);
});
