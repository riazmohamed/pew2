import { describe, expect, test } from "bun:test";
import {
  LIVENESS_TIMEOUT,
  WEBSOCKET_CONNECTING,
  WEBSOCKET_OPEN,
  reconnectDelay,
  resumeCheck,
} from "./daemonState";

describe("resumeCheck", () => {
  test("a socket that looks open is asked to prove it, not trusted", () => {
    // After hours suspended `OPEN` is stale: trusting it is what left the app
    // waiting for iOS to notice the connection was gone.
    expect(resumeCheck(WEBSOCKET_OPEN, 0)).toBe("probe");
  });
  test("an attempt frozen from before the app was put away is replaced", () => {
    expect(resumeCheck(WEBSOCKET_CONNECTING, LIVENESS_TIMEOUT)).toBe("replace");
  });
  test("an attempt that just started is left to finish", () => {
    expect(resumeCheck(WEBSOCKET_CONNECTING, 200)).toBe("wait");
  });
  test("no socket, or one closing, connects now", () => {
    expect(resumeCheck(undefined, 0)).toBe("connect");
    expect(resumeCheck(2, 0)).toBe("connect");
    expect(resumeCheck(3, 0)).toBe("connect");
  });
});

describe("reconnectDelay", () => {
  test("doubles from one second", () => {
    expect([0, 1, 2, 3].map((n) => reconnectDelay(n, true))).toEqual([1000, 2000, 4000, 8000]);
  });
  test("caps at ten seconds on screen", () => {
    expect(reconnectDelay(4, true)).toBe(10_000);
    expect(reconnectDelay(20, true)).toBe(10_000);
  });
  test("backs off to a minute off screen, without slowing the first tries", () => {
    expect(reconnectDelay(0, false)).toBe(1000);
    expect(reconnectDelay(5, false)).toBe(32_000);
    expect(reconnectDelay(20, false)).toBe(60_000);
  });
});
