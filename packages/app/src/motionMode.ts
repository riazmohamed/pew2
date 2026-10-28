/**
 * The app-wide "Animations: Calm / Full" choice, as pure rules so `bun test`
 * can read them. The store and the hook live in `ui/calmMotion.ts`.
 *
 * Calm is the default on Android: the Stage redesign's Skia animations (Pew's
 * frame loop, the launch and calling effects, the listening wave) made the
 * app crash more often there (see CLAUDE.md, Skia SIGSEGV in SkRecordDraw).
 */
export type MotionMode = "calm" | "full";

export const MOTION_HINT = "Calm uses less battery and is steadier on Android.";

export function defaultMotionMode(os: string): MotionMode {
  return os === "android" ? "calm" : "full";
}

/** A stored value; anything unreadable is the platform default. */
export function parseMotionMode(raw: string | null | undefined, os: string): MotionMode {
  return raw === "calm" || raw === "full" ? raw : defaultMotionMode(os);
}
