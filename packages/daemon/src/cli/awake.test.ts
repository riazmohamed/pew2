import { expect, test } from "bun:test";
import { pew2Assertions } from "./awake.js";

test("only pew2's caffeinate, and only when pmset lists it", () => {
  const ps = [
    "  100     1 /Users/me/.bun/bin/bun run packages/daemon/src/server.ts",
    "  200   100 /usr/bin/caffeinate -i -w 100",
    "  300     1 /usr/bin/caffeinate -d",
    "  400    50 /usr/bin/caffeinate -i -w 50",
  ].join("\n");
  const pmset =
    '   pid 200(caffeinate): [0x1] 00:01:00 PreventUserIdleSystemSleep named: "caffeinate command-line tool"';
  expect(pew2Assertions(ps, pmset)).toEqual([200]);
  expect(pew2Assertions(ps, "")).toEqual([]);
});
