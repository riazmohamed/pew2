/**
 * Keeps a live voice conversation alive with the screen locked, on Android.
 *
 * Android cuts the microphone from an app that is not in front unless a
 * microphone-type foreground service is running, and it only lets that service
 * start while the app *is* in front. So `startVoiceCallService` is called the
 * moment the microphone is granted, and `stopVoiceCallService` in every
 * teardown path. On iOS both are no-ops: `UIBackgroundModes: audio` does this
 * job there.
 *
 * Probed with `requireOptionalNativeModule`, the same way `ui/speech.ts` probes
 * its native module, so a build without it (an older dev client) simply keeps
 * the old on-screen-only behaviour instead of failing to start a call.
 */
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

interface VoiceCallServiceModule {
  start(title: string, text: string): boolean;
  stop(): void;
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<VoiceCallServiceModule>("VoiceCallService")
    : null;

/** True when the service started, so the call will survive a locked screen. */
export function startVoiceCallService(title: string, text: string): boolean {
  if (!native) return false;
  try {
    return native.start(title, text);
  } catch {
    return false;
  }
}

export function stopVoiceCallService(): void {
  try {
    native?.stop();
  } catch {
    // Not running.
  }
}
