/**
 * How wide the drawer is on a screen of a given width.
 *
 * A fraction of the window, capped: the strip of conversation left beside it is
 * what says the drawer is a layer over the same screen rather than a page of its
 * own, and the cap stops that becoming a whole empty column on a wide screen.
 *
 * A function rather than the constant this used to be. The app rotates now, so a
 * width sampled once at import is the launch orientation's number for the rest
 * of the process: a drawer measured in portrait and opened in landscape stops at
 * the cap regardless, but one measured in landscape and opened in portrait was
 * 380 points wide on a 375-point screen — the pane it pushes had nowhere left to
 * be, and the gesture that closes it was pushed off the edge with it.
 */

/** Never wider than this, however wide the screen is. */
export const DRAWER_MAX_WIDTH = 380;
/** …and never more of the screen than this. */
export const DRAWER_WIDTH_FRACTION = 0.88;

export function drawerWidth(windowWidth: number): number {
  return Math.min(windowWidth * DRAWER_WIDTH_FRACTION, DRAWER_MAX_WIDTH);
}
