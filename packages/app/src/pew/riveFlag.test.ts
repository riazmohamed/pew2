import { expect, test } from "bun:test";
import { riveMood } from "./riveFlag";

test("riveMood follows the pew.riv contract", () => {
  expect(riveMood("idle")).toBe(0);
  expect(riveMood("thinking")).toBe(1);
  expect(riveMood("dialing")).toBe(2);
  expect(riveMood("reading")).toBe(3);
  expect(riveMood("listening")).toBe(4);
  expect(riveMood("muted")).toBe(5);
  expect(riveMood("oops")).toBe(6);
  expect(riveMood("happy")).toBe(0);
});
