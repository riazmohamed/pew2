import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Alert, AppState } from "react-native";
import { SpokenPlayback, type SpokenCompletion, type PlaybackCompletion } from "../spokenReply";
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

export function useReadAloud(options: { onComplete?: (event: PlaybackCompletion) => void; onAction?: () => void } = {}) {
  const observers = useRef(options);
  observers.current = options;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [available] = useState(readAloudAvailable);
  const [playback] = useState(() => new SpokenPlayback(readAloud, redraw,
    (message) => Alert.alert("Spoken replies", message),
    (event) => observers.current.onComplete?.(event)));
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
  const toggle = useCallback(() => { observers.current.onAction?.(); playback.toggle(); }, [playback]);
  const stopPlayback = useCallback(() => { void playback.stop(); }, [playback]);
  const stop = useCallback(() => { observers.current.onAction?.(); stopPlayback(); }, [stopPlayback]);
  const replay = useCallback(() => { observers.current.onAction?.(); playback.replay(); }, [playback]);
  const read = useCallback(() => ({ enabled: playback.enabled, speaking: playback.speaking }), [playback]);
  const controls: ReadAloudControls = {
    available, enabled: playback.enabled, speaking: playback.speaking,
    canReplay: playback.canReplay, toggle, stop, replay,
  };
  return { controls, complete, captureStarted, captureEnded, stopPlayback, read };
}
