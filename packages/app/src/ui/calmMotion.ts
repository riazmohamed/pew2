/**
 * The one source of truth for Calm motion (see `motionMode.ts`).
 *
 * Starts at the platform default synchronously, so the first frame on Android
 * is already calm, then takes the stored choice once SecureStore answers.
 * `useReducedMotion` (accessibilityState) folds this in, so every animation
 * that honours Reduce Motion also honours Calm, and a change applies at once.
 */
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { defaultMotionMode, parseMotionMode, type MotionMode } from "../motionMode";
import { loadMotionMode, saveMotionMode } from "../preferences";

const state: { mode: MotionMode; touched: boolean } = {
  mode: defaultMotionMode(Platform.OS),
  touched: false,
};
const listeners = new Set<() => void>();

function publish(next: MotionMode) {
  if (state.mode === next) return;
  state.mode = next;
  for (const listener of listeners) listener();
}

void loadMotionMode().then((raw) => {
  // A choice made before the store answered is newer than what it holds.
  if (!state.touched) publish(parseMotionMode(raw, Platform.OS));
});

export function subscribeMotionMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getMotionMode(): MotionMode {
  return state.mode;
}

export function isCalm(): boolean {
  return state.mode === "calm";
}

/** Applies at once and is remembered across launches. */
export function setMotionMode(mode: MotionMode): void {
  state.touched = true;
  publish(mode);
  void saveMotionMode(mode);
}

export function useMotionMode(): MotionMode {
  return useSyncExternalStore(subscribeMotionMode, getMotionMode, getMotionMode);
}

/** True while Calm is on (whatever the OS Reduce Motion says). */
export function useCalmMotion(): boolean {
  return useMotionMode() === "calm";
}
