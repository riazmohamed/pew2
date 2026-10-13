import { expect, test } from "bun:test";
import { deskTargetLabel, deskTargets } from "./deskChoice";

test("no desk, no button", () => {
  expect(deskTargets(undefined, "ggcoder")).toEqual([]);
  expect(deskTargets({ available: false, native: ["ggcoder"] }, "ggcoder")).toEqual([]);
});

test("an older daemon (no native list) taps straight through to pew2 chat", () => {
  expect(deskTargets({ available: true }, "ggcoder")).toEqual(["chat"]);
});

test("a provider in desk.native gets the chooser, native first", () => {
  expect(deskTargets({ available: true, native: ["ggcoder"] }, "ggcoder")).toEqual(["native", "chat"]);
  expect(deskTargets({ available: true, native: ["ggcoder"] }, "claude-code")).toEqual(["chat"]);
  expect(deskTargets({ available: true, native: ["ggcoder"] }, undefined)).toEqual(["chat"]);
});

test("labels", () => {
  expect(deskTargetLabel("native")).toBe("Open in OG Coder");
  expect(deskTargetLabel("chat")).toBe("Open in pew2 chat");
});
