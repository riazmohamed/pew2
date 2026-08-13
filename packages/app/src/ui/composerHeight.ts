/**
 * How tall the composer is, given how open it is and how tall its draft measures.
 *
 * Split out of `Composer.tsx` for the same reason as every other layout module
 * here: the arithmetic is what the control feels like, and it is only checkable
 * in a file that imports nothing native. `Composer.tsx` cannot be imported by
 * the test runner at all — `react-native` ships Flow-typed source it cannot
 * parse — so anything left inside it is asserted by eye or not at all.
 *
 * Metrics arrive as an argument rather than from `../theme`, which imports
 * `react-native` and would drag the same wall in behind it.
 */

/** The three fixed heights the curve runs between. All in points. */
export interface ComposerBounds {
  /** The resting pill: one row, text inline between the two buttons. */
  collapsed: number;
  /** Everything in the control that is not text. */
  chrome: number;
  /** Floor: one line of text above the action row. */
  min: number;
  /** Ceiling: the most lines shown before the text scrolls internally. */
  max: number;
}

/**
 * The most of the screen the composer may ever take, as a fraction of it.
 *
 * Held upright this never binds — eight lines is barely a third of a phone. It
 * exists for the phone turned on its side, where the screen is shorter than the
 * box's own ceiling and a fully grown composer covers the conversation it is
 * being written about, keyboard and all.
 */
export const COMPOSER_MAX_SCREEN_FRACTION = 0.45;

/**
 * Never fewer than this, however short the screen is. Below three lines the box
 * stops being somewhere to write and becomes a slot to type into.
 */
export const COMPOSER_MIN_LINES = 3;

/**
 * Lines the box may grow to before its text scrolls, on a screen this tall.
 *
 * Lines rather than points because two things have to agree on the answer: the
 * height the box stops at, and the measured text height at which the input turns
 * its own scrolling on. Derived separately, the gap between them is a draft that
 * is clipped — grown as far as it may go, with no way to reach the rest of
 * itself.
 */
export function composerMaxLines({
  viewportHeight,
  lineHeight,
  chrome,
  maxLines,
}: {
  viewportHeight: number;
  lineHeight: number;
  /** Everything in the control that is not text. */
  chrome: number;
  /** The ceiling on a screen with room for it. */
  maxLines: number;
}): number {
  const room = viewportHeight * COMPOSER_MAX_SCREEN_FRACTION - chrome;
  return Math.max(COMPOSER_MIN_LINES, Math.min(maxLines, Math.floor(room / lineHeight)));
}

/**
 * A worklet, so the UI thread can evaluate it on its own frames without asking
 * JS for anything.
 *
 * Openness interpolates from the collapsed pill to whatever height the draft
 * needs *at this frame*, rather than the height itself being animated. That is
 * the whole point of the shape: an open/close eases, while a line added by a
 * wrap lands whole on the next frame even if an open is still running. Easing
 * the height instead left the box trailing the caret by the length of the
 * transition.
 *
 * @param bounds Heights sampled from the theme by the caller.
 * @param openness 0 collapsed, 1 fully open.
 * @param textHeight Measured height of the draft.
 */
export function composerHeight(
  bounds: ComposerBounds,
  openness: number,
  textHeight: number,
): number {
  "worklet";
  // The floor keeps a one-line draft to a one-line box rather than opening
  // pre-grown into space nothing occupies yet; the ceiling is where the box
  // stops and the input starts scrolling.
  const expanded = Math.min(bounds.max, Math.max(bounds.min, textHeight + bounds.chrome));
  return bounds.collapsed + (expanded - bounds.collapsed) * openness;
}
