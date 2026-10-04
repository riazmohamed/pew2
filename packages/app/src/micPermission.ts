/**
 * Getting microphone permission without leaving the app.
 *
 * Asking Android for a permission the app already holds still starts the
 * system's permission screen. It finishes at once and the user never sees it,
 * but the app is paused for the ~50ms it exists, which React Native reports as
 * the app leaving the foreground. Hands-free treats that as the user walking
 * away and pauses itself, so asking on every listen made it pause every time,
 * before it heard a word. Looking the permission up first never shows a screen;
 * asking is only for when it is not held yet, which is the one time a screen
 * should appear.
 *
 * Expo-free so it can be tested directly; `ui/speech.ts` supplies the module.
 */

export interface PermissionAnswer {
  granted: boolean;
}

export interface PermissionSource<T extends PermissionAnswer> {
  /** Reads the current state. Shows nothing. */
  get(): Promise<T>;
  /** Shows the system prompt when needed. Pauses the app on Android. */
  request(): Promise<T>;
}

/** The current permission when already granted, otherwise the user's answer. */
export async function ensureMicPermission<T extends PermissionAnswer>(
  source: PermissionSource<T>,
): Promise<T> {
  const current = await source.get();
  return current.granted ? current : source.request();
}
