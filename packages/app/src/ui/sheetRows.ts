/**
 * How many rows a list sheet may show before it has to scroll.
 *
 * Five, until the screen is too short to hold five — which is every phone in
 * landscape. A sheet sizes itself from this number, and it is bottom-anchored,
 * so a card taller than the screen does not clip: it grows off the *top*, taking
 * its own title and grabber with it. The command list still worked; it just no
 * longer said what it was, and the drag that dismisses it was somewhere above
 * the status bar.
 *
 * The result is deliberately fractional. Snapping down to whole rows throws away
 * up to a row of usable height, and a row cut in half at the fold is the clearest
 * possible statement that the list continues.
 */

/** Rows visible in a list sheet on a screen with room for all of them. */
export const SHEET_MAX_ROWS = 5;

export interface SheetRowsInput {
  /** The window's height, in points. */
  viewportHeight: number;
  /** Everything in the card that is not list: grabber, header, paddings, insets. */
  chrome: number;
  rowHeight: number;
  /** Rows to show when the screen is tall enough — `SHEET_MAX_ROWS`. */
  maxRows: number;
}

export function sheetVisibleRows({
  viewportHeight,
  chrome,
  rowHeight,
  maxRows,
}: SheetRowsInput): number {
  // One row is the floor. Below that the screen cannot hold a sheet at all, and
  // showing nothing would be worse than a card that overhangs slightly.
  return Math.max(1, Math.min(maxRows, sheetContentHeight(viewportHeight, chrome) / rowHeight));
}

/**
 * The tallest a sheet's content may be before it has to scroll: what the screen
 * has left once the chrome and the safe areas are taken out.
 *
 * Uncapped by rows, for the sheets that are not lists — an approval's options
 * are the one thing in this app that must never be off screen, and a thought is
 * as long as the agent made it.
 */
export function sheetContentHeight(viewportHeight: number, chrome: number): number {
  return Math.max(0, viewportHeight - chrome);
}
