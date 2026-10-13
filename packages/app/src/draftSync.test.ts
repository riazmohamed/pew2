import { describe, expect, test } from "bun:test";
import {
  createDraftThrottle,
  shouldApplyRemoteDraft,
  shouldReplaceDraft,
  shouldSendDraft,
  type Timers,
} from "./draftSync";

function fakeTimers() {
  let next = 1;
  const queue = new Map<number, () => void>();
  const timers: Timers = {
    set: (fn) => {
      const id = next++;
      queue.set(id, fn);
      return id;
    },
    clear: (h) => void queue.delete(h as number),
  };
  const tick = () => {
    const entries = [...queue.entries()];
    queue.clear();
    for (const [, fn] of entries) fn();
  };
  return { timers, tick, size: () => queue.size };
}

describe("shouldSendDraft", () => {
  test("requires an open socket and drafts === true", () => {
    expect(shouldSendDraft(true, true)).toBe(true);
    expect(shouldSendDraft(true, undefined)).toBe(false);
    expect(shouldSendDraft(true, false)).toBe(false);
    expect(shouldSendDraft(false, true)).toBe(false);
  });
});

describe("shouldApplyRemoteDraft", () => {
  test("drops our own echo", () => {
    expect(shouldApplyRemoteDraft({ text: "a", from: "me", sessionId: "s" }, "me", "s")).toBe(false);
  });
  test("applies for the session on screen only", () => {
    expect(shouldApplyRemoteDraft({ text: "a", from: "desk", sessionId: "s" }, "me", "s")).toBe(true);
    expect(shouldApplyRemoteDraft({ text: "a", from: "desk", sessionId: "t" }, "me", "s")).toBe(false);
    expect(shouldApplyRemoteDraft({ text: "a", from: "desk" }, "me", "s")).toBe(false);
  });
  test("both absent is the not-yet-started conversation", () => {
    expect(shouldApplyRemoteDraft({ text: "a", from: "desk" }, "me", undefined)).toBe(true);
    expect(shouldApplyRemoteDraft({ text: "a", from: "desk", sessionId: "s" }, "me", undefined)).toBe(false);
  });
});

describe("shouldReplaceDraft", () => {
  test("never while dictating, never when equal", () => {
    expect(shouldReplaceDraft("hi", "h", false)).toBe(true);
    expect(shouldReplaceDraft("hi", "h", true)).toBe(false);
    expect(shouldReplaceDraft("hi", "hi", false)).toBe(false);
  });
});

describe("createDraftThrottle", () => {
  test("sends the first at once and the latest on the trailing edge", () => {
    const sent: string[] = [];
    const t = fakeTimers();
    const throttle = createDraftThrottle((s) => sent.push(s), t.timers);
    throttle.push("h");
    throttle.push("he");
    throttle.push("hel");
    expect(sent).toEqual(["h"]);
    t.tick();
    expect(sent).toEqual(["h", "hel"]);
    t.tick();
    expect(sent).toEqual(["h", "hel"]);
    expect(t.size()).toBe(0);
  });
  test("an empty draft goes immediately and drops pending text", () => {
    const sent: string[] = [];
    const t = fakeTimers();
    const throttle = createDraftThrottle((s) => sent.push(s), t.timers);
    throttle.push("a");
    throttle.push("ab");
    throttle.push("");
    expect(sent).toEqual(["a", ""]);
    t.tick();
    expect(sent).toEqual(["a", ""]);
  });
  test("cancel drops pending text", () => {
    const sent: string[] = [];
    const t = fakeTimers();
    const throttle = createDraftThrottle((s) => sent.push(s), t.timers);
    throttle.push("a");
    throttle.push("ab");
    throttle.cancel();
    t.tick();
    expect(sent).toEqual(["a"]);
  });
});
