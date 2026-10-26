import { describe, expect, it } from "bun:test";
import { installLogTimes, logTime, stampArgs } from "./log-time.js";
import { describePush } from "./push.js";

const AT = new Date(2026, 9, 22, 4, 5, 6);

describe("log times", () => {
  it("formats local wall-clock time", () => {
    expect(logTime(AT)).toBe("2026-10-22 04:05:06");
  });

  it("stamps the daemon's tagged lines", () => {
    expect(stampArgs(["[relay] online"], AT)).toEqual(["2026-10-22 04:05:06 [relay] online"]);
  });

  it("leaves the banner and raw values alone, so the pairing QR code still scans", () => {
    expect(stampArgs(["█▀▀▀▀▀█ ▄"], AT)).toEqual(["█▀▀▀▀▀█ ▄"]);
    const error = new Error("boom");
    expect(stampArgs([error], AT)).toEqual([error]);
  });

  it("installs over console and can be undone", () => {
    const seen: unknown[][] = [];
    const real = console.log;
    console.log = (...args: unknown[]) => seen.push(args);
    const undo = installLogTimes(() => AT);
    try {
      console.log("[push] test");
    } finally {
      undo();
      console.log = real;
    }
    expect(seen).toEqual([["2026-10-22 04:05:06 [push] test"]]);
  });
});

describe("describePush: every attempt leaves a line", () => {
  it("accepted", () => {
    expect(describePush(1, { tickets: [{ status: "ok" }] })).toBe("[push] 1 banner(s): accepted");
  });

  it("names a rejection, so a dead token can be told from a lost push", () => {
    const tickets = [
      { status: "ok" },
      { status: "error", details: { error: "DeviceNotRegistered" } },
    ];
    expect(describePush(2, { tickets })).toBe(
      "[push] 2 banner(s): 1 accepted, 1 rejected (DeviceNotRegistered)",
    );
  });

  it("an HTTP refusal and a failed send", () => {
    expect(describePush(1, { status: 429 })).toBe("[push] 1 banner(s): refused by Expo (HTTP 429)");
    expect(describePush(1, { failed: new Error("fetch failed") })).toBe(
      "[push] 1 banner(s): not sent (fetch failed)",
    );
  });
});
