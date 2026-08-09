import { expect, test } from "bun:test";
import { tokensUsed, usageUpdate } from "./ogcoder-usage.js";

test("cached tokens count toward the window", () => {
  // The reason the meter exists: with caching, `inputTokens` is only the
  // uncached remainder, so counting it alone makes a nearly-full thread read as
  // nearly empty right up until it compacts.
  expect(tokensUsed({ inputTokens: 1_000, outputTokens: 500 })).toBe(1_500);
  expect(
    tokensUsed({ inputTokens: 1_000, outputTokens: 500, cacheRead: 80_000, cacheWrite: 2_000 }),
  ).toBe(83_500);
});

test("absent, negative and non-numeric counts contribute nothing", () => {
  expect(tokensUsed(undefined)).toBe(0);
  expect(tokensUsed({})).toBe(0);
  expect(tokensUsed({ inputTokens: -5, outputTokens: Number.NaN })).toBe(0);
  expect(tokensUsed({ inputTokens: Number.POSITIVE_INFINITY })).toBe(0);
});

test("a complete reading becomes a usage_update", () => {
  expect(usageUpdate({ inputTokens: 20_000, outputTokens: 1_325 }, 1_000_000)).toEqual({
    sessionUpdate: "usage_update",
    used: 21_325,
    size: 1_000_000,
  });
});

test("no window means no meter, rather than a guessed denominator", () => {
  // The app omits the row when usage is absent. A meter with an invented
  // denominator is worse than no meter.
  expect(usageUpdate({ inputTokens: 20_000 }, undefined)).toBeUndefined();
  expect(usageUpdate({ inputTokens: 20_000 }, 0)).toBeUndefined();
});

test("a turn that spent nothing reports nothing, not 0%", () => {
  // A meter reading zero while tokens are plainly being spent reads as broken.
  expect(usageUpdate({}, 200_000)).toBeUndefined();
  expect(usageUpdate(undefined, 200_000)).toBeUndefined();
});
