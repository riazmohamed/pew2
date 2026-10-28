/**
 * The pulse line that stands in for Pew in Calm mode: a row of LED dots that
 * trace a heartbeat while the agent works and stretch into speech bars while
 * it talks. Pure worklets, so `bun test` holds the shapes and the UI thread
 * runs them; only transforms and opacity move (the GPU-cheap properties).
 *
 * Patterns follow voice-assistant practice: one look per state (rest, think,
 * work, speak/listen), an ECG's P-QRS-T complex sweeping left to right with a
 * fading trail like a monitor, and equalizer bars with cascading phases.
 */
import type { PewMood } from "./engineBody";

/** ecg: the heartbeat sweeps. voice: speech bars. still: a resting line. */
export type PulseKind = "ecg" | "voice" | "still";

export function pulseKind(mood: PewMood): PulseKind {
  switch (mood) {
    case "working":
    case "thinking":
    case "dialing":
      return "ecg";
    case "talking":
    case "listening":
    case "typing":
    case "reading":
    case "celebrate":
      return "voice";
    default:
      return "still";
  }
}

/** One full cycle, in ms: a resting heart for thinking, quicker for work. */
export function pulsePeriod(kind: PulseKind, mood: PewMood): number {
  if (kind === "ecg") return mood === "thinking" ? 1900 : 1250;
  if (kind === "voice") return 1050;
  return 0;
}

/** Dots across the line for a box this size. */
export function pulseBars(size: number): number {
  if (size >= 120) return 15;
  if (size >= 60) return 11;
  if (size >= 32) return 9;
  return 7;
}

function bump(d: number, centre: number, width: number): number {
  "worklet";
  const z = (d - centre) / width;
  return Math.exp(-z * z);
}

/**
 * The ECG trace's height (-1..1, up is positive) at distance `d` from the
 * beat. `w` is one dot's spacing, so each wave is wide enough for a dot to
 * catch it: P, a small dip (Q), the spike (R), a dip (S), then T.
 */
export function ecgHeight(d: number, w: number): number {
  "worklet";
  return (
    0.16 * bump(d, -3.2 * w, 1.1 * w) -
    0.18 * bump(d, -1 * w, 0.45 * w) +
    1 * bump(d, 0, 0.55 * w) -
    0.38 * bump(d, 1 * w, 0.45 * w) +
    0.3 * bump(d, 3.6 * w, 1.4 * w)
  );
}

/** Where a dot sits in the motion at phase `t` (0..1). */
export interface PulseFrame {
  /** Vertical offset, -1..1 of the amplitude (up positive). */
  lift: number;
  /** Bar stretch, 1 = a round dot. */
  stretch: number;
  /** 0..1. */
  opacity: number;
}

/**
 * A dot's frame. `x` is its place across the line (0..1), `w` the spacing
 * between dots (as a fraction of the line), `seed` its own voice offset.
 */
export function pulseFrame(
  kind: PulseKind,
  x: number,
  t: number,
  w: number,
  seed: number,
): PulseFrame {
  "worklet";
  if (kind === "still") {
    // A flat trace with one low beat in the middle, fully lit.
    return { lift: 0.35 * ecgHeight(x - 0.5, w), stretch: 1, opacity: 0.85 };
  }
  if (kind === "ecg") {
    // The beat crosses from just off the left edge to just off the right, so
    // the line is flat between beats. Behind the sweep the trace fades, like
    // a monitor's phosphor.
    const head = -0.25 + 1.5 * t;
    const lift = ecgHeight(x - head, w);
    const behind = head - x;
    const trail = behind >= 0 ? Math.max(0, 1 - behind / 0.9) : 0;
    return { lift, stretch: 1, opacity: 0.32 + 0.68 * Math.max(trail, Math.abs(lift)) };
  }
  // voice: two waves per dot at different speeds so it never reads as a loop,
  // cascading across the row, highest in the middle like a speech meter.
  const a = Math.sin(2 * Math.PI * (t + seed));
  const b = Math.sin(2 * Math.PI * (2 * t + seed * 1.7));
  const level = Math.max(0, Math.min(1, 0.5 + 0.32 * a + 0.18 * b));
  const envelope = 1 - Math.abs(x - 0.5) * 1.1;
  return { lift: 0, stretch: 1 + level * Math.max(0.1, envelope) * 7, opacity: 0.95 };
}
