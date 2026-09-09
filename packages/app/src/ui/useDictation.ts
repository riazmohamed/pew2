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

export interface Dictation {
  /** False on a device with no recogniser, so the button can be hidden entirely. */
  available: boolean;
  listening: boolean;
  toggle: () => void;
  /** Stop without committing a partial guess. For send, blur and session change. */
  cancel: () => void;
}

export function useDictation({ draft, onDraftChange, onMessage, onCaptureStart, onCaptureEnd }: UseDictationOptions): Dictation {
  const [listening, setListening] = useState(false);
  const captureStartRef = useRef(onCaptureStart);
  captureStartRef.current = onCaptureStart;
  const captureEndRef = useRef(onCaptureEnd);
  captureEndRef.current = onCaptureEnd;
  // One place for "listening ended": stop, cancel, error and end all clear the
  // flag, and a hook on the flag catches every one of them.
  useEffect(() => {
    if (!listening) captureEndRef.current?.();
  }, [listening]);
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
    wanted.current = false;
    session.current?.cancel();
    session.current = undefined;
    setListening(false);
  }, []);

  // A mic left open outlives the screen that opened it.
  useEffect(() => stopSession, [stopSession]);

  const toggle = useCallback(() => {
    if (wanted.current) {
      wanted.current = false;
      // A deliberate stop asks for the final result, so the last few words the
      // recogniser had not committed still land in the draft.
      session.current?.stop();
      session.current = undefined;
      setListening(false);
      haptics.finished();
      return;
    }

    wanted.current = true;
    state.current = beginDictation(draftRef.current());
    setListening(true);
    haptics.sent();
    captureStartRef.current?.();

    void startDictation({
      // `isFinal` is not cosmetic: under `continuous`, the recogniser restarts
      // from empty after every final result, so a final that is not folded into
      // the base gets overwritten by the next sentence.
      onTranscript: (transcript, isFinal) => {
        const next = applyTranscript(state.current, transcript, isFinal);
        state.current = next.state;
        changeRef.current(next.draft);
      },
      onError: (code, detail) => {
        wanted.current = false;
        session.current = undefined;
        setListening(false);
        const message = dictationMessage(code, detail);
        if (message) {
          messageRef.current(message);
          haptics.failed();
        }
      },
      onEnd: () => {
        wanted.current = false;
        session.current = undefined;
        setListening(false);
      },
    }).then((started) => {
      if (!started) {
        // Permission refused, or the module is missing. `onError` has already
        // said so; this only clears the optimistic listening state.
        wanted.current = false;
        setListening(false);
        return;
      }
      // Tapped off while the permission dialog was up: the recogniser started
      // anyway and would otherwise hold the microphone with nothing watching.
      if (!wanted.current) {
        started.cancel();
        return;
      }
      session.current = started;
    });
  }, []);

  // Memoized: `Composer` is memoized precisely because streamed chunks
  // re-render this screen many times a second, and a fresh object here would
  // re-render it on every one of them.
  return useMemo(
    () => ({ available, listening, toggle, cancel: stopSession }),
    [available, listening, toggle, stopSession],
  );
}
