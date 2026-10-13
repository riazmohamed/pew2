import { expect, test } from "bun:test";
import { DENIED_NOTE, Desk, PENDING_NOTE, deskArgs, deskStatus, explainAppleScript } from "./desk.js";

test("only macOS can open a window", () => {
  expect(deskStatus("darwin")).toEqual({ available: true });
  expect(deskStatus("linux").available).toBe(false);
});

test("the window follows the session's own project and starts on it", () => {
  expect(deskArgs({ sessionId: "ggcoder-abc", cwd: "/p/app" })).toEqual(["--project", "/p/app", "--focus", "ggcoder-abc"]);
  expect(deskArgs({})).toEqual(["--all"]);
});

test("osascript failures are told apart", () => {
  expect(explainAppleScript({ code: 1, stderr: "execution error: Not authorized to send Apple events to iTerm. (-1743)", timedOut: false }).kind).toBe("denied");
  expect(explainAppleScript({ code: null, stderr: "", timedOut: true }).kind).toBe("pending");
  expect(explainAppleScript({ code: 1, stderr: "boom", timedOut: false }).kind).toBe("failed");
});

const fake = (outcome: { code: number | null; stderr: string; timedOut: boolean }, hasITerm = true) => {
  const calls = { applescript: [] as string[], command: [] as string[] };
  let clock = 0;
  const desk = new Desk({
    runAppleScript: async (script) => (calls.applescript.push(script), outcome),
    openCommandFile: async (command) => void calls.command.push(command),
    hasITerm: () => hasITerm,
    now: () => clock,
  });
  return { desk, calls, tick: (ms: number) => (clock += ms) };
};

if (process.platform === "darwin") {
  test("iTerm is used when it is allowed, with the session quoted into pew2 chat", async () => {
    const { desk, calls } = fake({ code: 0, stderr: "", timedOut: false });
    expect(await desk.open({ sessionId: "ggcoder-abc", cwd: "/p/my app" }, {})).toEqual({ ok: true, app: "iTerm" });
    // Quoted twice over (shell inside zsh -lc inside AppleScript), so the path
    // with a space survives as one argument.
    expect(calls.applescript[0]).toContain("chat --here --project '\\\\''/p/my app'\\\\'' --focus ggcoder-abc");
    expect(calls.command).toEqual([]);
  });

  test("a refused iTerm falls back to Terminal and says how to allow it", async () => {
    const { desk, calls } = fake({ code: 1, stderr: "(-1743)", timedOut: false });
    expect(await desk.open({ sessionId: "s", cwd: "/p" }, {})).toEqual({ ok: true, app: "Terminal", message: DENIED_NOTE });
    expect(calls.command).toHaveLength(1);
  });

  test("a pending permission prompt is reported, not doubled up in Terminal", async () => {
    const { desk, calls } = fake({ code: null, stderr: "", timedOut: true });
    expect(await desk.open({ sessionId: "s", cwd: "/p" }, {})).toEqual({ ok: false, message: PENDING_NOTE });
    expect(calls.command).toEqual([]);
  });

  test("no iTerm: Terminal, no AppleScript at all", async () => {
    const { desk, calls } = fake({ code: 0, stderr: "", timedOut: false }, false);
    expect(await desk.open({ sessionId: "s", cwd: "/p" }, {})).toEqual({ ok: true, app: "Terminal" });
    expect(calls.applescript).toEqual([]);
  });

  test("a double tap opens one window", async () => {
    const { desk, calls, tick } = fake({ code: 0, stderr: "", timedOut: false });
    await desk.open({ sessionId: "s", cwd: "/p" }, {});
    expect((await desk.open({ sessionId: "s", cwd: "/p" }, {})).message).toBe("Already opening.");
    tick(5_000);
    await desk.open({ sessionId: "s", cwd: "/p" }, {});
    expect(calls.applescript).toHaveLength(2);
  });
}
