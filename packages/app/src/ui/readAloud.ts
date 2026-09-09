import { requireOptionalNativeModule } from "expo-modules-core";
import type { ReadAloudDriver } from "../spokenReply";

type Speech = typeof import("expo-speech");

function speechModule(): Speech | undefined {
  try {
    if (!requireOptionalNativeModule("ExpoSpeech")) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-speech") as Speech;
  } catch {
    return undefined;
  }
}

export function readAloudAvailable(): boolean {
  return !!speechModule();
}

export const readAloud: ReadAloudDriver = {
  async stop(): Promise<void> {
    await speechModule()?.stop();
  },
  async speak(text, done, error, current): Promise<void> {
    const speech = speechModule();
    if (!speech) { error(); return; }
    const voices = await speech.getAvailableVoicesAsync();
    if (!current()) return;
    if (!voices.length || text.length > speech.maxSpeechInputLength) { error(); return; }
    speech.speak(text, {
      onDone: done,
      onStopped: done,
      onError: error,
      // Let iOS manage interruptions rather than reuse the recogniser's session.
      useApplicationAudioSession: false,
    });
  },
};
