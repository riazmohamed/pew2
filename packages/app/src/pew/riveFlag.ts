/**
 * Whether big calm Pews (Home, Switch agent, the call) draw from the Rive
 * file instead of the flat pulse line. Small Pews always stay FlatPew. Pure
 * and Expo-free (tested with `bun`).
 */
import type { PewMood } from "./engineBody";

export const RIVE_PEW = true;

/** The smallest Pew drawn with Rive; anything smaller stays FlatPew. */
export const RIVE_MIN_SIZE = 80;

/** PewMood as the `mood` number of the Rive file's `Pew` view model. */
export function riveMood(mood: PewMood): number {
  switch (mood) {
    case "idle":
      return 0;
    case "thinking":
      return 1;
    case "working":
    case "dialing":
      return 2;
    case "talking":
    case "typing":
    case "reading":
    case "celebrate":
      return 3;
    case "listening":
      return 4;
    case "sleepy":
    case "muted":
      return 5;
    case "oops":
      return 6;
    default:
      return 0;
  }
}
