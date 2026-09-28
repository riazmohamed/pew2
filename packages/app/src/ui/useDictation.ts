/**
 * Composer-side state for dictation.
 *
 * Owns the one thing the pure merge rule cannot: a live native session that has
 * to be torn down on unmount, on send, and on switching sessions. A recogniser
 * left running holds the audio session open — on iOS that ducks other audio and
 * shows the orange mic indicator indefinitely, which reads as the app spying.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyTranscript,
  beginDictation,
  dictationMessage,
  type DictationState,
} from "../transcription";
import { speechAvailable, startDictation, type DictationSession } from "./speech";
import { haptics } from "./haptics";

export interface UseDictationOptions {
  /** The draft as it stands, read when dictation starts. */
  draft: () => string;
  onDraftChange: (draft: string) => void;
  /** Shown to the user; empty string means "say nothing". */
  onMessage: (message: string) => void;
  /**
   * Fired as the mic is asked for, before the recogniser starts. Spoken cues
   * use it to stop talking. Not awaited: the recogniser must never wait on
   * playback, because a stop that never confirms would look like a dead mic.
   */
  onCaptureStart?: () => void;
  /** Fired whenever listening ends, however it ended. */
  onCaptureEnd?: () => void;
}

export interface AutomaticDictationObserver {
  current(): boolean;
  started(): void;
  transcript(utterance: string): void;
  ended(): void;
  failed(): void;
}

export interface Dictation {
  /** False on a device with no recogniser, so the button can be hidden entirely. */
  available: boolean;
  listening: boolean;
  toggle: () => void;
  /** Stop without committing a partial guess. For send, blur and session change. */
  cancel: () => void;
}

export interface AutomaticDictation extends Dictation {
  startAutomatic: (observer: AutomaticDictationObserver) => Promise<boolean>;
  /** Requests final results; only native onEnd confirms completion. */
  finishAutomatic: () => void;
}

export function useDictation({ draft, onDraftChange, onMessage, onCaptureStart, onCaptureEnd }: UseDictationOptions): AutomaticDictation {
  const [listening, setListening] = useState(false);
  const captureStartRef = useRef(onCaptureStart);
  captureStartRef.current = onCaptureStart;
  const captureEndRef = useRef(onCaptureEnd);
  captureEndRef.current = onCaptureEnd;
  const generation = useRef(0);
  const releaseCapture = useCallback(() => {
    setListening(false);
    captureEndRef.current?.();
  }, []);
  const session = useRef<DictationSession | undefined>(undefined);
  const state = useRef<DictationState>(beginDictation(""));
  // Read at start rather than captured in a dep: the draft changes on every
  // keystroke and restarting listeners for that would drop audio mid-word.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const changeRef = useRef(onDraftChange);
  changeRef.current = onDraftChange;
  const messageRef = useRef(onMessage);
  messageRef.current = onMessage;

  // Resolved once: the answer cannot change while the app is running, and
  // asking the native module on every render is wasted work.
  const [available] = useState(speechAvailable);

  /**
   * Whether the user wants the mic on, as opposed to whether it is on yet.
   *
   * `startDictation` awaits a permission dialog, so there is a window with no
   * session to stop. Intent is tracked separately: a tap during that window
   * must cancel the session the moment it arrives, and must not be mistaken for
   * a request to start a second recogniser on top of the first.
   */
  const wanted = useRef(false);

  const stopSession = useCallback(() => {
    ++generation.current;
    wanted.current = false;
    session.current?.cancel();
    session.current = undefined;
    releaseCapture();
  }, [releaseCapture]);

  // A mic left open outlives the screen that opened it.
  useEffect(() => stopSession, [stopSession]);

  const start = useCallback(async (observer?: AutomaticDictationObserver): Promise<boolean> => {
    if (wanted.current || (observer && !observer.current())) return false;
    const ticket = ++generation.current;
    let ended = false;
    const current = () => ticket === generation.current && !ended && (!observer || observer.current());
    wanted.current = true;
    state.current = beginDictation(draftRef.current());
    setListening(true);
    haptics.sent();
    captureStartRef.current?.();

    try {
      const started = await startDictation({
        canStart: () => current() && wanted.current,
        onStart: () => { if (current()) observer?.started(); },
        // Keep the existing merge rule: isFinal alone is never a boundary.
        onTranscript: (transcript, isFinal) => {
          if (!current()) return;
          const next = applyTranscript(state.current, transcript, isFinal);
          state.current = next.state;
          changeRef.current(next.draft);
          observer?.transcript(transcript);
        },
        onError: (code, detail) => {
          if (!current()) return;
          wanted.current = false;
          releaseCapture();
          observer?.failed();
          const message = dictationMessage(code, detail);
          if (message) { messageRef.current(message); haptics.failed(); }
        },
        onEnd: () => {
          if (!current()) return;
          ended = true;
          wanted.current = false;
          session.current = undefined;
          releaseCapture();
          observer?.ended();
        },
      });
      if (!current() || !wanted.current || !started) {
        started?.cancel();
        if (ticket === generation.current) {
          wanted.current = false;
          releaseCapture();
        }
        return false;
      }
      session.current = started;
      return true;
    } catch {
      if (current()) {
        wanted.current = false;
        releaseCapture();
        observer?.failed();
        messageRef.current(dictationMessage("audio-capture"));
      }
      return false;
    }
  }, [releaseCapture]);

  const toggle = useCallback(() => {
    if (wanted.current) {
      wanted.current = false;
      session.current?.stop();
      // Manual UI remains optimistic, but keep the handle until native end so
      // cancellation can still invalidate the final-result listeners.
      releaseCapture();
      haptics.finished();
      return;
    }
    void start(); // Never wait on playback to start manual dictation.
  }, [releaseCapture, start]);

  const finishAutomatic = useCallback(() => { session.current?.stop(); }, []);

  // Memoized: `Composer` is memoized precisely because streamed chunks
  // re-render this screen many times a second, and a fresh object here would
  // re-render it on every one of them.
  return useMemo(
    () => ({ available, listening, toggle, cancel: stopSession, startAutomatic: start, finishAutomatic }),
    [available, listening, toggle, stopSession, start, finishAutomatic],
  );
}
