import { expect, test } from "bun:test";
import { readRing, ringAction, ringEnded } from "./androidRing";

test("a voice.ring frame is read, with its focus when it has one", () => {
  expect(
    readRing({
      t: "voice.ring",
      ringId: "ring_1",
      title: "billing needs you",
      caller: "Pew · billing",
      body: "2 waiting",
      focus: "s1:approval:p1",
    }),
  ).toEqual({
    ringId: "ring_1",
    title: "billing needs you",
    caller: "Pew · billing",
    body: "2 waiting",
    focus: "s1:approval:p1",
  });
  expect(readRing({ t: "voice.ring", ringId: "ring_2", body: "Done." })).toEqual({
    ringId: "ring_2",
    title: "pew2 needs you",
    caller: "Pew",
    body: "Done.",
  });
});

test("anything else, or a ring missing its id or body, is not a ring", () => {
  expect(readRing({ t: "voice.status" })).toBeUndefined();
  expect(readRing({ t: "voice.ring", body: "x" })).toBeUndefined();
  expect(readRing({ t: "voice.ring", ringId: "r" })).toBeUndefined();
  expect(readRing(null)).toBeUndefined();
  expect(readRing("voice.ring")).toBeUndefined();
});

test("a phone the system rings never rings itself too, and a call already on is left alone", () => {
  expect(ringAction({ systemRings: true, consented: true, callActive: false })).toBe("ignore");
  expect(ringAction({ systemRings: false, consented: true, callActive: true })).toBe("ignore");
});

test("without consent to calls it is a banner only; with it, a ring", () => {
  expect(ringAction({ systemRings: false, consented: false, callActive: false })).toBe("banner");
  expect(ringAction({ systemRings: false, consented: true, callActive: false })).toBe("ring");
});

test("a declined or missed ring tells the daemon under the ring's id", () => {
  const ring = { ringId: "ring_9", title: "t", caller: "Pew", body: "b" };
  expect(ringEnded(ring, "declined")).toEqual({
    t: "voice.end",
    callId: "ring_9",
    reason: "declined",
  });
  expect(ringEnded(ring, "missed")).toEqual({ t: "voice.end", callId: "ring_9", reason: "missed" });
});
