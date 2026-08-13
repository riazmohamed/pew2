import { expect, test } from "bun:test";
import { SHEET_MAX_ROWS, sheetVisibleRows } from "./sheetRows";

const ROW = 60;
/** Roughly what a sheet spends on grabber, header, padding and insets. */
const CHROME = 160;

const rows = (viewportHeight: number) =>
  sheetVisibleRows({ viewportHeight, chrome: CHROME, rowHeight: ROW, maxRows: SHEET_MAX_ROWS });

test("a phone held upright shows the full five rows", () => {
  expect(rows(852)).toBe(SHEET_MAX_ROWS);
  expect(rows(667)).toBe(SHEET_MAX_ROWS);
});

test("landscape shows fewer rows rather than growing off the top of the screen", () => {
  const landscape = rows(393);
  expect(landscape).toBeLessThan(SHEET_MAX_ROWS);
  expect(CHROME + landscape * ROW).toBeLessThanOrEqual(393);
});

test("the fold lands mid-row, which is what says the list continues", () => {
  expect(Number.isInteger(rows(393))).toBe(false);
});

test("one row is the floor, however little room is left", () => {
  expect(rows(CHROME)).toBe(1);
  expect(rows(0)).toBe(1);
});
