/**
 * How wide the drawer is on a screen of a given width.
 *
 * The whole screen: the drawer is a page of its own (the Switchboard), with
 * its own close button and a left swipe, so nothing of the conversation needs
 * to stay beside it.
 *
 * A function rather than a constant read at import. The app rotates, so a width
 * sampled once is the launch orientation's number for the rest of the process:
 * a drawer measured in landscape and opened in portrait ran off the screen, and
 * the pane it pushes (and the gesture that closes it) went with it.
 */
export function drawerWidth(windowWidth: number): number {
  return Math.max(0, windowWidth);
}
