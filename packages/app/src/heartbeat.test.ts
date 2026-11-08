import { describe, expect, test } from "bun:test";
import { DEAD_AFTER_MS, IDLE_PING_MS, createHeartbeat } from "./heartbeat";

/** A hand-driven clock: timers fire only when `advance` passes them. */
function harness() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sent: number[] = [];
  const dead: string[] = [];
  const hb = createHeartbeat({
    send: () => {
      sent.push(now);
      return true;
    },
    dead: (why) => dead.push(why),
    now: () => now,
    setTimer: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimer: (handle) => timers.delete(handle as number),
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  };
  return { hb, sent, dead, advance, timers, at: () => now };
}

describe("heartbeat", () => {
  test("sends the keepalive after silence, not while frames arrive", () => {
    const h = harness();
    h.hb.start();
    h.hb.heard(true); // the first ping's answer
    expect(h.sent).toEqual([0]);
    for (let i = 0; i < 10; i++) {
      h.advance(5_000);
      h.hb.heard(false);
    }
    expect(h.sent).toEqual([0]);
    h.advance(IDLE_PING_MS);
    expect(h.sent).toEqual([0, 50_000 + IDLE_PING_MS]);
    expect(h.dead).toEqual([]);
  });

  test("reconnects when a socket that answered pings goes silent", () => {
    const h = harness();
    h.hb.start();
    h.hb.heard(true);
    h.advance(DEAD_AFTER_MS - 1);
    expect(h.dead).toEqual([]);
    h.advance(1);
    expect(h.dead).toEqual(["no answer to the keepalive"]);
    expect(h.timers.size).toBe(0);
  });

  test("a far end that never answers pings causes no reconnect and no loop", () => {
    const h = harness();
    h.hb.start();
    h.advance(10 * 60_000);
    expect(h.dead).toEqual([]);
    expect(h.sent).toEqual([0]);
    expect(h.hb.running).toBe(false);
    expect(h.timers.size).toBe(0);
  });

  test("stopped (backgrounded) leaves no timer and sends nothing", () => {
    const h = harness();
    h.hb.start();
    h.hb.heard(true);
    h.hb.stop();
    expect(h.timers.size).toBe(0);
    h.advance(10 * 60_000);
    expect(h.sent).toEqual([0]);
    expect(h.dead).toEqual([]);
    // Back on screen: one ping at once, then the steady check again.
    h.hb.start();
    expect(h.sent.length).toBe(2);
    expect(h.timers.size).toBe(1);
  });

  test("a keepalive that cannot be written replaces the socket", () => {
    const dead: string[] = [];
    const hb = createHeartbeat({
      send: () => false,
      dead: (why) => dead.push(why),
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    hb.start();
    expect(dead).toEqual(["keepalive could not be sent"]);
    expect(hb.running).toBe(false);
  });
});
