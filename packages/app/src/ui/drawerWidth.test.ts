import { expect, test } from "bun:test";
import { drawerWidth } from "./drawerWidth";

test("the drawer is the whole screen it is on, in either orientation", () => {
  expect(drawerWidth(375)).toBe(375);
  expect(drawerWidth(852)).toBe(852);
});

test("the drawer never outgrows the screen it is on", () => {
  // The rotation bug this replaced: a landscape-sampled width on a portrait
  // screen left the pane, and the way back out, off the edge.
  for (const width of [320, 375, 390, 430, 744, 852, 1024, 1366]) {
    expect(drawerWidth(width)).toBeLessThanOrEqual(width);
  }
});
