import { expect, test } from "bun:test";
import { defaultMotionMode, parseMotionMode } from "./motionMode";

test("calm by default on Android, full on iOS", () => {
  expect(defaultMotionMode("android")).toBe("calm");
  expect(defaultMotionMode("ios")).toBe("full");
});

test("a stored choice wins over the default", () => {
  expect(parseMotionMode("full", "android")).toBe("full");
  expect(parseMotionMode("calm", "ios")).toBe("calm");
});

test("missing or junk falls back to the platform default", () => {
  expect(parseMotionMode(null, "android")).toBe("calm");
  expect(parseMotionMode(undefined, "ios")).toBe("full");
  expect(parseMotionMode("fast", "android")).toBe("calm");
});
