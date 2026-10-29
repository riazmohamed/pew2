import { expect, test } from "bun:test";
import {
  anyOpen,
  closeLabel,
  deskActions,
  deskTargetLabel,
  deskTargets,
  needsSheet,
  openWindows,
} from "./deskChoice";

test("no desk, no button", () => {
  expect(deskTargets(undefined, "ggcoder")).toEqual([]);
  expect(deskTargets({ available: false, native: ["ggcoder"] }, "ggcoder")).toEqual([]);
});

test("an older daemon (no native list) taps straight through to pew2 chat", () => {
  expect(deskTargets({ available: true }, "ggcoder")).toEqual(["chat"]);
});

test("a provider in desk.native gets the chooser, native first", () => {
  expect(deskTargets({ available: true, native: ["ggcoder"] }, "ggcoder")).toEqual([
    "native",
    "chat",
  ]);
  expect(deskTargets({ available: true, native: ["ggcoder"] }, "claude-code")).toEqual(["chat"]);
  expect(deskTargets({ available: true, native: ["ggcoder"] }, undefined)).toEqual(["chat"]);
});

test("labels", () => {
  expect(deskTargetLabel("native")).toBe("Open in OG Coder");
  expect(deskTargetLabel("chat")).toBe("Open in pew2 chat");
});

test("with nothing open, the menu is where it can open, as before", () => {
  const desk = { available: true, native: ["ggcoder"] };
  expect(deskActions(desk, "ggcoder", "a1")).toEqual([
    { kind: "open", target: "native" },
    { kind: "open", target: "chat" },
  ]);
  // One place and nothing open: the caller taps straight through.
  expect(deskActions({ available: true }, "claude-code", "a1")).toEqual([
    { kind: "open", target: "chat" },
  ]);
});

test("a window open for this conversation puts Close first, with the other place to open", () => {
  const nativeOpen = {
    available: true,
    native: ["ggcoder"],
    windows: [{ agentSessionId: "a1", kind: "native" as const }],
  };
  expect(deskActions(nativeOpen, "ggcoder", "a1")).toEqual([
    { kind: "close" },
    { kind: "open", target: "chat" },
  ]);
  expect(closeLabel(openWindows(nativeOpen, "a1"), "OG Coder")).toBe("Close OG Coder");
  // Another conversation's window is not this one's.
  expect(deskActions(nativeOpen, "ggcoder", "b2")[0]).toEqual({ kind: "open", target: "native" });

  const chatOpen = { available: true, windows: [{ agentSessionId: "a1", kind: "chat" as const }] };
  expect(deskActions(chatOpen, "claude-code", "a1")).toEqual([{ kind: "close" }]);
  expect(closeLabel(openWindows(chatOpen, "a1"))).toBe("Close pew2 chat");

  const both = {
    available: true,
    native: ["ggcoder"],
    windows: [
      { agentSessionId: "a1", kind: "native" as const },
      { agentSessionId: "a1", kind: "chat" as const },
    ],
  };
  expect(deskActions(both, "ggcoder", "a1")).toEqual([{ kind: "close" }]);
  expect(closeLabel(openWindows(both, "a1"))).toBe("Close on computer");
  // Never more than two actions: Android's alert holds three buttons with Cancel.
  for (const desk of [nativeOpen, chatOpen, both])
    expect(deskActions(desk, "ggcoder", "a1").length).toBeLessThanOrEqual(2);
});

test("a new chat (no agent id yet) has nothing to close", () => {
  const desk = { available: true, windows: [{ agentSessionId: "a1", kind: "chat" as const }] };
  expect(openWindows(desk, undefined)).toEqual({ native: false, chat: false, app: false });
});

test("the GG Coder app is offered only when the daemon lists the provider in desk.app", () => {
  const desk = { available: true, native: ["ggcoder"], app: ["gg-goals", "ggcoder"] };
  expect(deskTargets(desk, "ggcoder")).toEqual(["native", "app", "chat"]);
  expect(deskTargets(desk, "gg-goals")).toEqual(["app", "chat"]);
  expect(deskTargets(desk, "claude-code")).toEqual(["chat"]);
  // An older daemon, or the app's phone control off: no app.
  expect(deskTargets({ available: true, native: ["ggcoder"] }, "ggcoder")).toEqual([
    "native",
    "chat",
  ]);
  expect(deskTargetLabel("app")).toBe("Open in GG Coder app");
});

test("three places to open go to a list on Android, an alert elsewhere", () => {
  const desk = { available: true, native: ["ggcoder"], app: ["ggcoder"] };
  const actions = deskActions(desk, "ggcoder", "a1");
  expect(actions).toEqual([
    { kind: "open", target: "native" },
    { kind: "open", target: "app" },
    { kind: "open", target: "chat" },
  ]);
  expect(needsSheet(actions, "android")).toBe(true);
  expect(needsSheet(actions, "ios")).toBe(false);
  expect(needsSheet(deskActions({ ...desk, app: undefined }, "ggcoder", "a1"), "android")).toBe(
    false,
  );
});

test("an app window reads as the GG Coder app, and holds the agent's place", () => {
  const desk = {
    available: true,
    native: ["ggcoder"],
    app: ["ggcoder"],
    windows: [{ agentSessionId: "a1", kind: "native" as const, app: true }],
  };
  const open = openWindows(desk, "a1");
  expect(open).toEqual({ native: false, chat: false, app: true });
  expect(anyOpen(open)).toBe(true);
  expect(closeLabel(open, "OG Coder")).toBe("Close GG Coder app");
  // iTerm is not offered while the app has it; pew2 chat still is.
  expect(deskActions(desk, "ggcoder", "a1")).toEqual([
    { kind: "close" },
    { kind: "open", target: "chat" },
  ]);
  // An iTerm window still reads as OG Coder, and the app is not offered beside it.
  const iterm = { ...desk, windows: [{ agentSessionId: "a1", kind: "native" as const }] };
  expect(closeLabel(openWindows(iterm, "a1"), "OG Coder")).toBe("Close OG Coder");
  expect(deskActions(iterm, "ggcoder", "a1")).toEqual([
    { kind: "close" },
    { kind: "open", target: "chat" },
  ]);
});

test("Close stays offered after plan mode moved the conversation to a new agent id (29 Oct)", () => {
  // The phone still holds the old agent id; the daemon announces the window
  // under the new one, with pew2's own session id alongside.
  const desk = {
    available: true,
    native: ["ggcoder"],
    app: ["ggcoder"],
    windows: [
      { agentSessionId: "after-plan", kind: "native" as const, app: true, sessionId: "ggcoder-1" },
    ],
  };
  expect(openWindows(desk, "before-plan", "ggcoder-1")).toEqual({
    native: false,
    chat: false,
    app: true,
  });
  expect(deskActions(desk, "ggcoder", "before-plan", "ggcoder-1")[0]).toEqual({ kind: "close" });
  // Without the session id (an older daemon), the agent id still matches as before.
  expect(openWindows(desk, "after-plan").app).toBe(true);
  expect(openWindows(desk, "before-plan").app).toBe(false);
});
