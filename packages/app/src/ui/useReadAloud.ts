import { useCallback, useEffect, useReducer, useState } from "react";
import { Alert, AppState } from "react-native";
import { SpokenPlayback, type SpokenCompletion } from "../spokenReply";
import { readAloud, readAloudAvailable } from "./readAloud";

export interface ReadAloudControls {
  available: boolean;
  enabled: boolean;
  speaking: boolean;
  canReplay: boolean;
  toggle: () => void;
  stop: () => void;
  replay: () => void;
}

export function useReadAloud() {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [available] = useState(readAloudAvailable);
  const [playback] = useState(() => new SpokenPlayback(readAloud, redraw,
    (message) => Alert.alert("Spoken cues", message)));
  useEffect(() => {
    playback.activate();
    playback.context(AppState.currentState === "active");
    const listener = AppState.addEventListener("change", (state) => {
      playback.context(state === "active");
    });
    return () => { listener.remove(); playback.dispose(); };
  }, [playback]);
  const complete = useCallback((turn: SpokenCompletion) => playback.complete(turn), [playback]);
  // Fire-and-forget: the mic must never wait on playback confirming it stopped.
  const captureStarted = useCallback(() => { void playback.microphone(); }, [playback]);
  const captureEnded = useCallback(() => playback.captureEnded(), [playback]);
  const toggle = useCallback(() => playback.toggle(), [playback]);
  const stop = useCallback(() => { void playback.stop(); }, [playback]);
  const replay = useCallback(() => playback.replay(), [playback]);
  const controls: ReadAloudControls = {
    available, enabled: playback.enabled, speaking: playback.speaking,
    canReplay: playback.canReplay, toggle, stop, replay,
  };
  return { controls, complete, captureStarted, captureEnded };
}
