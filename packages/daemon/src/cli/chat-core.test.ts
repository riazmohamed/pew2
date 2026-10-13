import { expect, test } from "bun:test";
import { isLocalWatcher, decideClaim } from "../device-claim.js";
import {
  DraftThrottle,
  Follow,
  applyInput,
  insideProject,
  providerFromSessionId,
  backoffMs,
  chatDeviceId,
  draftApplies,
  draftIsActivity,
  pickAgent,
  renderEvent,
  rowsFor,
  type TimerApi,
} from "./chat-core.js";

test("chat ids are CLI-prefixed (never claim the pairing) and distinct per window", () => {
  const a = chatDeviceId("mac", "aa11");
  const b = chatDeviceId("mac", "bb22");
  expect(a).not.toBe(b);
  expect(isLocalWatcher(a)).toBe(true);
  const decision = decideClaim(undefined, a);
  expect(decision.ok).toBe(true);
  expect(decision.ok && decision.claim).toBeFalsy();
  // Nor is it refused by a pairing the phone already claimed.
  expect(decideClaim("phone-uuid", a).ok).toBe(true);
});

test("follow: latest activity wins, a pin holds", () => {
  const follow = new Follow();
  expect(follow.current).toBe("");
  expect(follow.activity("s1", 1, { providerId: "echo" })).toBe(true);
  expect(follow.activity("s1", 2)).toBe(false);
  expect(follow.activity("s2", 3)).toBe(true);
  expect(follow.current).toBe("s2");
  expect(follow.list(["s1", "s2"]).map((r) => r.sessionId)).toEqual(["s2", "s1"]);
  expect(follow.meta("s1").providerId).toBe("echo");

  const pinned = new Follow("s1");
  expect(pinned.activity("s2", 5)).toBe(false);
  expect(pinned.current).toBe("s1");
  expect(pinned.switchTo("s2")).toBe(true);
});

test("drafts: own echo ignored, other conversation ignored, clears are not activity", () => {
  expect(draftApplies({ sessionId: "s1", from: "me" }, "me", "s1")).toBe(false);
  expect(draftApplies({ sessionId: "s1", from: "phone" }, "me", "s1")).toBe(true);
  expect(draftApplies({ sessionId: "s2", from: "phone" }, "me", "s1")).toBe(false);
  expect(draftApplies({ from: "phone" }, "me", "")).toBe(true);
  expect(draftIsActivity({ from: "phone", text: "a" }, "me")).toBe(true);
  expect(draftIsActivity({ from: "phone", text: "" }, "me")).toBe(false);
  expect(draftIsActivity({ from: "me", text: "a" }, "me")).toBe(false);
});

function fakeTimers() {
  let next: (() => void) | undefined;
  const api: TimerApi = {
    set: (fn) => {
      next = fn;
      return 1;
    },
    clear: () => {
      next = undefined;
    },
  };
  return { api, fire: () => next?.(), pending: () => next !== undefined };
}

test("draft throttle: trailing, latest text, clears immediately", () => {
  const sent: [string, string][] = [];
  const timers = fakeTimers();
  const throttle = new DraftThrottle((k, t) => sent.push([k, t]), 60, timers.api);
  throttle.update("s1", "h");
  throttle.update("s1", "he");
  throttle.update("s1", "hel");
  expect(sent).toEqual([]);
  timers.fire();
  expect(sent).toEqual([["s1", "hel"]]);

  throttle.update("s1", "hell");
  throttle.update("s1", "");
  expect(sent).toEqual([["s1", "hel"], ["s1", ""]]);
  expect(timers.pending()).toBe(false);

  throttle.update("s1", "x");
  throttle.cancel();
  timers.fire();
  expect(sent).toHaveLength(2);
});

test("line editor: typing, paste, backspace, Ctrl-U, Enter, Ctrl-C", () => {
  expect(applyInput("", "héllo")).toEqual({ buffer: "héllo", actions: [] });
  expect(applyInput("ab", "\x7f").buffer).toBe("a");
  expect(applyInput("abc", "\x15").buffer).toBe("");
  expect(applyInput("hi", "\r")).toEqual({ buffer: "", actions: [{ kind: "submit", text: "hi" }] });
  expect(applyInput("", "\x1b[A").buffer).toBe("");
  expect(applyInput("x", "\x03").actions).toEqual([{ kind: "quit" }]);
  const state = { pasting: false };
  expect(applyInput("", "\x1b[200~a\nb\x1b[201~", state)).toEqual({ buffer: "a\nb", actions: [] });
  expect(state.pasting).toBe(false);
});

test("events read as terminal lines", () => {
  expect(renderEvent({ kind: "user_message", text: "hi" })).toEqual({ kind: "user", text: "hi" });
  expect(
    renderEvent({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } }),
  ).toEqual({ kind: "text", text: "ok" });
  expect(renderEvent({ update: { sessionUpdate: "tool_call", title: "Read file" } })).toEqual({
    kind: "tool",
    text: "Read file",
  });
  expect(renderEvent({ update: { sessionUpdate: "agent_thought_chunk", content: { text: "hmm" } } })).toBeUndefined();
  expect(
    renderEvent({
      kind: "permission_request",
      requestId: "r1",
      params: { toolCall: { title: "rm -rf" }, options: [{ optionId: "a", name: "Allow" }] },
    }),
  ).toEqual({ kind: "permission", requestId: "r1", title: "rm -rf", options: [{ optionId: "a", name: "Allow" }] });
});

test("agent choice, rows and backoff", () => {
  const providers = [
    { id: "echo", available: true },
    { id: "ggcoder", available: true },
  ];
  expect(pickAgent("codex", "echo", providers)).toBe("codex");
  expect(pickAgent(undefined, "echo", providers)).toBe("echo");
  expect(pickAgent(undefined, undefined, providers)).toBe("ggcoder");
  expect(pickAgent(undefined, undefined, [{ id: "echo", available: true }])).toBe("echo");
  expect(rowsFor("\x1b[36m›\x1b[0m abc", 3)).toBe(2);
  expect(rowsFor("a\nb", 80)).toBe(2);
  expect(backoffMs(0)).toBe(500);
  expect(backoffMs(10)).toBe(10_000);
});

test("a lone Esc quits, but arrow keys and pastes do not", () => {
  expect(applyInput("hi", "\x1b").actions).toEqual([{ kind: "quit" }]);
  expect(applyInput("hi", "\x1b[D")).toEqual({ buffer: "hi", actions: [] });
  expect(applyInput("", "\x1b[200~a\x1b[201~")).toEqual({ buffer: "a", actions: [] });
});

test("insideProject matches the project and its subfolders, not a sibling", () => {
  expect(insideProject("/a/app", "/a/app")).toBe(true);
  expect(insideProject("/a/app/pkg", "/a/app/")).toBe(true);
  expect(insideProject("/a/app2", "/a/app")).toBe(false);
  expect(insideProject(undefined, "/a/app")).toBe(false);
});

test("a project window follows only its own project's conversations", () => {
  const follow = new Follow(undefined, "/p/one");
  follow.meta("s1").cwd = "/p/one";
  follow.meta("s2").cwd = "/p/two";
  expect(follow.activity("s2", 1)).toBe(false);
  expect(follow.current).toBe("");
  expect(follow.activity("s1", 2)).toBe(true);
  expect(follow.current).toBe("s1");
  // Not-yet-started drafts and unknown-cwd sessions do not pull it away.
  expect(follow.activity("", 3)).toBe(false);
  expect(follow.activity("s3", 4)).toBe(false);
  expect(follow.list(["s1", "s2", "s3"]).map((r) => r.sessionId)).toEqual(["s1"]);
});

test("a window with no project still follows everything", () => {
  const follow = new Follow();
  follow.meta("s2").cwd = "/p/two";
  expect(follow.activity("s2", 1)).toBe(true);
  expect(follow.activity("", 2)).toBe(true);
});

test("the agent is read off a daemon session id, and only a known one", () => {
  const providers = [{ id: "ggcoder" }, { id: "claude-code" }];
  expect(providerFromSessionId("ggcoder-mgp3x1", providers)).toBe("ggcoder");
  expect(providerFromSessionId("claude-code-mgp3x1", providers)).toBe("claude-code");
  expect(providerFromSessionId("echo_1", providers)).toBeUndefined();
  expect(providerFromSessionId("nope-123", providers)).toBeUndefined();
});
