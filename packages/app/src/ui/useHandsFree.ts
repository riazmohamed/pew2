import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { HandsFreeLoop, type HandsFreeContext, type HandsFreeState } from "../handsFree";
import type { PlaybackCompletion, SpokenCompletion } from "../spokenReply";
import type { AutomaticDictation, Dictation } from "./useDictation";

export interface HandsFreeControls {
  enabled: boolean;
  state: HandsFreeState;
  reason: string;
  unavailable: () => string | undefined;
  toggle: () => void;
  resume: () => void;
  pause: () => void;
}

export interface HandsFreeBinding {
  completion(turn: SpokenCompletion | undefined, sessionId: string): boolean;
  playbackEnded(event: PlaybackCompletion): void;
  pause(): void;
  canSend(sessionId: string, draftVersion: number): boolean;
}

interface Options {
  read(): HandsFreeContext;
  dictation: AutomaticDictation;
  send(sessionId: string, draftVersion: number): boolean;
  stopPlayback(): void;
}

/** Native events feed one controller. Draft text stays in the composer, not React root state. */
export function useHandsFree(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(true);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const expectedPlayback = useRef<{ id: string; ticket: number } | undefined>(undefined);
  const [loop] = useState<HandsFreeLoop>((): HandsFreeLoop => new HandsFreeLoop({
    read: () => ({ ...latest.current.read(), foreground: AppState.currentState === "active" }),
    start: (ticket) => latest.current.dictation.startAutomatic({
      current: () => loop.captureCurrent(ticket) && AppState.currentState === "active",
      started: () => loop.nativeStarted(ticket),
      transcript: (utterance) => loop.transcript(ticket, utterance),
      ended: () => loop.nativeEnded(ticket),
      failed: () => loop.failed(ticket),
    }),
    finish: () => latest.current.dictation.finishAutomatic(),
    cancel: () => latest.current.dictation.cancel(),
    send: (sessionId, version) => latest.current.send(sessionId, version),
    stopPlayback: () => latest.current.stopPlayback(),
    changed: () => { if (mounted.current) redraw(); },
  }));

  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener("change", (state) => {
      if (state !== "active") loop.pause("App left the foreground. Resume when ready.");
    });
    const blur = Platform.OS === "android"
      ? AppState.addEventListener("blur", () => loop.pause("Phone interaction interrupted voice. Resume when ready."))
      : undefined;
    return () => {
      mounted.current = false;
      listener.remove(); blur?.remove(); loop.dispose();
    };
  }, [loop]);
  useEffect(() => { loop.reconcile(); });

  const pause = useCallback(() => loop.pause(), [loop]);
  const resume = useCallback(() => loop.enable(), [loop]);
  const toggle = useCallback(() => { if (loop.enabled) loop.off(); else loop.enable(); }, [loop]);
  const completion = useCallback((turn: SpokenCompletion | undefined, sessionId: string): boolean => {
    if (!loop.enabled) return true;
    // An idle without a live completion key may be a duplicate/history event.
    // Empty live replies have a key and are explicitly paused by the controller.
    if (!turn || turn.sessionId !== sessionId) return false;
    if (!loop.completion(turn)) return false;
    expectedPlayback.current = { id: turn.id, ticket: loop.ticket };
    return true;
  }, [loop]);
  const playbackEnded = useCallback((event: PlaybackCompletion) => {
    const expected = expectedPlayback.current;
    if (!expected || expected.id !== event.id) return;
    expectedPlayback.current = undefined;
    loop.playbackEnded(expected.ticket, event.id, event.sessionId, event.outcome);
  }, [loop]);
  const canSend = useCallback((sessionId: string, version: number) => loop.canSend(sessionId, version), [loop]);
  const manualMic = useCallback(() => {
    const wasActive = loop.active;
    loop.pause("Manual microphone selected. Resume hands-free deliberately.");
    // Pausing an automatic recording is itself this tap's stop action. A second
    // tap starts ordinary dictation, without accidentally toggling it back on.
    if (!wasActive || !latest.current.dictation.listening) latest.current.dictation.toggle();
  }, [loop]);
  const unavailable = useCallback(() => loop.active ? undefined : loop.unavailable(), [loop]);
  const controls: HandsFreeControls = {
    enabled: loop.enabled, state: loop.state, reason: loop.reason,
    unavailable, toggle, resume, pause,
  };
  const dictation: Dictation = { ...options.dictation, toggle: manualMic };
  const binding: HandsFreeBinding = { completion, playbackEnded, pause, canSend };
  return { controls, dictation, binding };
}
