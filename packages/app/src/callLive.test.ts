import { describe, expect, test } from "bun:test";
import { LIVE_MAX_CHARS, callLive, lastExchange, liveSessionId } from "./callLive";
import type { Turn } from "./daemonTypes";

const turn = (role: Turn["role"], text: string, id = `${role}-${text.length}`): Turn => ({ id, role, text });

describe("liveSessionId", () => {
  test("prefers the spotlight", () => {
    expect(liveSessionId("s1", { focus: "s2:x" })).toBe("s1");
  });
  test("falls back to the focus item's session, then its prefix", () => {
    expect(liveSessionId(undefined, { focus: "f1", inbox: [{ id: "f1", sessionId: "s9" }] as never })).toBe("s9");
    expect(liveSessionId(undefined, { focus: "s3:perm" })).toBe("s3");
  });
  test("nothing without spotlight or focus", () => {
    expect(liveSessionId(undefined, {})).toBeUndefined();
  });
});

describe("lastExchange", () => {
  test("last prompt and the agent text after it, thoughts skipped", () => {
    const turns = [turn("user", "old"), turn("agent", "old reply"), turn("user", "fix the\n  build"), turn("thought", "hmm"), turn("agent", "On it."), turn("agent", "Done.")];
    expect(lastExchange(turns)).toEqual({ prompt: "fix the build", reply: "On it.\n\nDone." });
  });
  test("keeps the tail of a long reply", () => {
    const { reply } = lastExchange([turn("user", "go"), turn("agent", `${"a".repeat(LIVE_MAX_CHARS)}END`)]);
    expect(reply.length).toBe(LIVE_MAX_CHARS);
    expect(reply.startsWith("…")).toBe(true);
    expect(reply.endsWith("END")).toBe(true);
  });
  test("empty transcript", () => {
    expect(lastExchange([])).toEqual({ reply: "" });
  });
});

describe("callLive", () => {
  const lane = { sessionId: "s1", folder: "pew2", status: "working" as const, lines: [{ kind: "text" as const, text: "Reading files", at: 1 }, { kind: "pew" as const, text: "asked it", at: 2 }] };

  test("undefined without a session id or anything known about it", () => {
    expect(callLive(undefined, [], [lane])).toBeUndefined();
    expect(callLive("nope", [], [lane])).toBeUndefined();
  });
  test("transcript wins when it has turns", () => {
    const live = callLive("s1", [{ id: "s1", turns: [turn("user", "hi"), turn("agent", "hello")], busy: false }], [lane]);
    expect(live).toEqual({ sessionId: "s1", project: "pew2", prompt: "hi", text: "hello", fromBoard: false, working: true });
  });
  test("falls back to the board lane's lines when never opened", () => {
    const live = callLive("s1", [{ id: "s1", turns: [] }], [lane]);
    expect(live?.text).toBe("Reading files");
    expect(live?.fromBoard).toBe(true);
  });
  test("project from cwd when no folder", () => {
    const live = callLive("s2", [{ id: "s2", turns: [turn("agent", "x")], busy: true, cwd: "/a/b/repo" }], []);
    expect(live?.project).toBe("repo");
    expect(live?.working).toBe(true);
  });
});
