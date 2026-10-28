import { expect, test } from "bun:test";
import { ecgHeight, pulseBars, pulseFrame, pulseKind, pulsePeriod } from "./pulseShape";

test("moods pick their motion", () => {
  expect(pulseKind("working")).toBe("ecg");
  expect(pulseKind("thinking")).toBe("ecg");
  expect(pulseKind("talking")).toBe("voice");
  expect(pulseKind("listening")).toBe("voice");
  expect(pulseKind("idle")).toBe("still");
  expect(pulseKind("sleepy")).toBe("still");
  expect(pulsePeriod("still", "idle")).toBe(0);
  expect(pulsePeriod("ecg", "thinking")).toBeGreaterThan(pulsePeriod("ecg", "working"));
});

test("dots scale with the box", () => {
  expect(pulseBars(20)).toBe(7);
  expect(pulseBars(40)).toBe(9);
  expect(pulseBars(80)).toBe(11);
  expect(pulseBars(200)).toBe(15);
});

test("the ECG complex: spike at the beat, dips either side, flat far away", () => {
  const w = 0.05;
  expect(ecgHeight(0, w)).toBeGreaterThan(0.9);
  expect(ecgHeight(w, w)).toBeLessThan(0);
  expect(ecgHeight(-w, w)).toBeLessThan(0.2);
  expect(ecgHeight(3.6 * w, w)).toBeGreaterThan(0.2);
  expect(Math.abs(ecgHeight(0.6, w))).toBeLessThan(0.01);
});

test("frames stay in range for every kind", () => {
  for (const kind of ["ecg", "voice", "still"] as const)
    for (let x = 0; x <= 1; x += 0.05)
      for (let t = 0; t < 1; t += 0.05) {
        const f = pulseFrame(kind, x, t, 0.05, x * 0.37);
        expect(f.lift).toBeGreaterThanOrEqual(-1);
        expect(f.lift).toBeLessThanOrEqual(1.01);
        expect(f.stretch).toBeGreaterThanOrEqual(1);
        expect(f.stretch).toBeLessThanOrEqual(8);
        expect(f.opacity).toBeGreaterThan(0);
        expect(f.opacity).toBeLessThanOrEqual(1);
      }
});

test("the ecg sweep lifts the dot under the beat and dims the line ahead of it", () => {
  // At t = 0.5 the head is at 0.5.
  expect(pulseFrame("ecg", 0.5, 0.5, 0.05, 0).lift).toBeGreaterThan(0.9);
  expect(pulseFrame("ecg", 0.95, 0.5, 0.05, 0).opacity).toBeLessThan(0.4);
  expect(pulseFrame("ecg", 0.4, 0.5, 0.05, 0).opacity).toBeGreaterThan(0.8);
});
