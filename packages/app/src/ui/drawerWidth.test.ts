import { expect, test } from "bun:test";
import { DRAWER_MAX_WIDTH, drawerWidth } from "./drawerWidth";

test("a narrow phone keeps a strip of the conversation beside the drawer", () => {
  // 375pt is the narrowest phone still supported. The remainder is what the
  // user taps or pushes to get back.
  expect(drawerWidth(375)).toBeLessThan(375);
  expect(drawerWidth(375)).toBe(330);
});

test("a wide screen stops at the cap rather than becoming a column", () => {
  // A phone in landscape, and a tablet.
  expect(drawerWidth(852)).toBe(DRAWER_MAX_WIDTH);
  expect(drawerWidth(1024)).toBe(DRAWER_MAX_WIDTH);
});

test("the drawer never outgrows the screen it is on", () => {
  // The rotation bug this replaced: a landscape-sampled 380 on a portrait
  // screen left the pane, and the way back out, off the edge.
  for (const width of [320, 375, 390, 430, 744, 852, 1024, 1366]) {
    expect(drawerWidth(width)).toBeLessThanOrEqual(width);
  }
});
