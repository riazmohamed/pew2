import { expect, test } from "bun:test";
import {
  COMPOSER_MIN_LINES,
  composerHeight,
  composerMaxLines,
  type ComposerBounds,
} from "./composerHeight";

/**
 * Close to the real control's proportions without depending on the theme, which
 * imports `react-native`. One line of text is 20, the chrome around it is 52,
 * and eight lines is the ceiling.
 */
const bounds: ComposerBounds = { collapsed: 48, chrome: 52, min: 72, max: 212 };

const LINE = 20;

test("a collapsed control is the pill, whatever the draft measures", () => {
  expect(composerHeight(bounds, 0, LINE)).toBe(48);
  expect(composerHeight(bounds, 0, LINE * 6)).toBe(48);
});

test("an open control fits the draft above the action row", () => {
  expect(composerHeight(bounds, 1, LINE * 3)).toBe(112);
  expect(composerHeight(bounds, 1, LINE * 4)).toBe(132);
});

test("a one-line draft opens to one line, not into empty space", () => {
  // Below the floor the box must not shrink under its own single-line height:
  // an input reporting less than a line while it lays out would otherwise open
  // pre-collapsed and then jump.
  expect(composerHeight(bounds, 1, 0)).toBe(72);
  expect(composerHeight(bounds, 1, LINE)).toBe(72);
});

test("growth stops at the ceiling so the text scrolls instead", () => {
  expect(composerHeight(bounds, 1, LINE * 8)).toBe(212);
  expect(composerHeight(bounds, 1, LINE * 40)).toBe(212);
});

test("a wrap partway through an open lands whole rather than easing", () => {
  // The same openness, one line taller: the difference is the full line, not a
  // fraction of it phased in over the remaining transition. This is the
  // property that keeps the box level with the caret.
  const midOpen = composerHeight(bounds, 0.5, LINE * 3);
  const midOpenTaller = composerHeight(bounds, 0.5, LINE * 4);

  expect(midOpenTaller - midOpen).toBe(10);
  // Half of the line, because the box is half open — and it arrives on the
  // frame the wrap did.
  expect(midOpen).toBe(80);
});

test("openness runs the whole way between the pill and the fitted height", () => {
  expect(composerHeight(bounds, 0, LINE * 3)).toBe(48);
  expect(composerHeight(bounds, 1, LINE * 3)).toBe(112);
});

test("a phone held upright reaches the full ceiling", () => {
  // 45% of 852 is 383 points — more than eight lines and the chrome need, so
  // the screen never enters into it.
  expect(composerMaxLines({ viewportHeight: 852, lineHeight: LINE, chrome: 52, maxLines: 8 })).toBe(
    8,
  );
});

test("a phone held sideways stops the box short of the conversation", () => {
  const lines = composerMaxLines({
    viewportHeight: 393,
    lineHeight: LINE,
    chrome: 52,
    maxLines: 8,
  });

  expect(lines).toBeLessThan(8);
  // What it is actually for: the grown box plus its chrome leaves most of a
  // short screen to the transcript.
  expect(lines * LINE + 52).toBeLessThanOrEqual(393 * 0.45);
});

test("three lines survive a screen with no room for them", () => {
  // Split view, a landscape keyboard on a small phone, or an accessibility text
  // size: the floor holds rather than collapsing to a single typing slot.
  expect(composerMaxLines({ viewportHeight: 200, lineHeight: LINE, chrome: 52, maxLines: 8 })).toBe(
    COMPOSER_MIN_LINES,
  );
});
