import { describe, expect, test } from "bun:test";
import {
  newlyWorking,
  backAction,
  busiestLane,
  callBarLine,
  callBarVisible,
  callReconnecting,
  callScreenVisible,
  minimiseOnPhase,
} from "./callMinimise";
import type { LaneView } from "./voiceBoard";

function lane(over: Partial<LaneView>): LaneView {
  return {
    sessionId: "s1",
    slot: 0,
    folder: "pew2",
    agentName: "OG Coder",
    status: { word: "WORKING", tone: "agent", pulse: true },
    mood: "idle",
    spotlight: false,
    steps: 0,
    ...over,
  };
}
const CALL = { phase: "live", pewAudio: false, userSpeaking: false, muted: false } as const;

describe("minimise", () => {
  test("screen and bar swap while a call is in progress", () => {
    expect(callScreenVisible("live", false)).toBe(true);
    expect(callScreenVisible("live", true)).toBe(false);
    expect(callBarVisible("live", true)).toBe(true);
    expect(callBarVisible("connecting", true)).toBe(true);
    expect(callScreenVisible("idle", false)).toBe(false);
    expect(callBarVisible("idle", true)).toBe(false);
  });
  test("an ended or failed call is never hidden", () => {
    expect(callScreenVisible("failed", true)).toBe(true);
    expect(callBarVisible("ended", true)).toBe(false);
  });
  test("phase changes", () => {
    expect(minimiseOnPhase(true, "live")).toEqual({ minimised: true, dismiss: false });
    expect(minimiseOnPhase(true, "failed")).toEqual({ minimised: false, dismiss: false });
    expect(minimiseOnPhase(true, "ended")).toEqual({ minimised: false, dismiss: true });
    expect(minimiseOnPhase(false, "ended")).toEqual({ minimised: false, dismiss: false });
  });
  test("reconnecting only during a call", () => {
    expect(callReconnecting("live", "offline")).toBe(true);
    expect(callReconnecting("live", "online")).toBe(false);
    expect(callReconnecting("ended", "offline")).toBe(false);
  });
});

describe("callBarLine", () => {
  test("status words", () => {
    expect(callBarLine(CALL, false, []).status).toBe("Listening");
    expect(callBarLine({ ...CALL, pewAudio: true }, false, []).status).toBe("Pew speaking");
    expect(callBarLine({ ...CALL, phase: "connecting" }, false, []).status).toBe("Connecting…");
    expect(callBarLine({ ...CALL, pewAudio: true }, true, []).status).toBe("Reconnecting…");
    expect(callBarLine({ ...CALL, muted: true }, false, []).status).toBe("Muted");
  });
  test("busiest lane and its step", () => {
    const working = lane({
      sessionId: "w",
      folder: "site",
      mood: "working",
      current: {
        key: "k",
        kind: "tool",
        text: "Editing App.tsx",
        shown: "",
        typing: false,
        fresh: false,
      },
    });
    expect(callBarLine(CALL, false, [lane({}), working]).lane).toEqual({
      sessionId: "w",
      folder: "site",
      step: "Editing App.tsx",
    });
    const spot = lane({ sessionId: "p", spotlight: true });
    expect(busiestLane([working, spot])?.sessionId).toBe("p");
    expect(busiestLane([lane({})])).toBeUndefined();
    expect(callBarLine(CALL, false, [spot]).lane?.step).toBe("WORKING");
  });
});

describe("backAction", () => {
  test("priority order", () => {
    const all = { callExpanded: true, sheet: { closable: true }, drawerOpen: true };
    expect(backAction(all)).toBe("minimise");
    expect(backAction({ ...all, callExpanded: false })).toBe("closeSheet");
    expect(backAction({ ...all, callExpanded: false, sheet: { closable: false } })).toBe(
      "holdSheet",
    );
    expect(backAction({ callExpanded: false, drawerOpen: true })).toBe("closeDrawer");
    expect(backAction({ callExpanded: false, drawerOpen: false })).toBe("system");
  });
});

describe("newlyWorking: the call steps aside for new work", () => {
  test("a lane that starts working is picked once", () => {
    const first = newlyWorking(new Set(), [lane({ sessionId: "a", mood: "working" })]);
    expect(first.sessionId).toBe("a");
    const again = newlyWorking(first.working, [lane({ sessionId: "a", mood: "working" })]);
    expect(again.sessionId).toBeUndefined();
  });

  test("idle lanes never count, and a lane that rests then works again counts again", () => {
    expect(newlyWorking(new Set(), [lane({ sessionId: "a", mood: "idle" })]).sessionId).toBe(
      undefined,
    );
    const rested = newlyWorking(new Set(["a"]), [lane({ sessionId: "a", mood: "idle" })]);
    expect(rested.working.size).toBe(0);
    expect(
      newlyWorking(rested.working, [lane({ sessionId: "a", mood: "thinking" })]).sessionId,
    ).toBe("a");
  });
});
