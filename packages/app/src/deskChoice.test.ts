import { expect, test } from "bun:test";
import { closeLabel, deskActions, deskTargetLabel, deskTargets, openWindows } from "./deskChoice";

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
  expect(openWindows(desk, undefined)).toEqual({ native: false, chat: false });
});
