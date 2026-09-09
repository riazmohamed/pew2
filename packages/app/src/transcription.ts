/**
 * Merging dictated speech into a draft that may already have text in it.
 *
 * Two rules pull against each other, and getting only one of them right is how
 * dictation loses words.
 *
 * 1. **Interim results restate the whole utterance**, not the next few words.
 *    Appending them yields "hello hello there hello there world". So the
 *    volatile tail is *replaced* on every result.
 * 2. **We run `continuous: true`, so one recording holds many utterances.** The
 *    recogniser closes a segment and starts the next from empty. Treat that as
 *    rule 1 and sentence two overwrites sentence one — a paragraph of speech
 *    arrives as its last phrase.
 *
 * The tempting fix is to trust `isFinal` as the segment boundary. It is not
 * trustworthy. On iOS 18 the Expo module cannot get a real one (Apple stopped
 * delivering it: forums.developer.apple.com/forums/thread/762952) and infers it
 * from `speechRecognitionMetadata.speechDuration > 0` — its own comment says
 * this "can be emitted multiple times during a continuous session". The same
 * segment can therefore be announced final several times, and can still be
 * *revised* afterwards. Folding every final into a committed base duplicates
 * text when finals repeat; ignoring finals drops whole segments. That pair is
 * the intermittent "sometimes it replaces, sometimes it doesn't".
 *
 * So the boundary is decided from the transcripts themselves: a result that
 * *extends* the open segment revises it, and only a result that does not starts
 * a new one. `isFinal` is kept as a hint that a boundary may follow — never as
 * the thing that moves text into the committed part.
 *
 * Kept away from the Expo module (`ui/speech.ts`) so the rule is testable —
 * `bun test` cannot parse React Native's Flow syntax, and this is the part with
 * behaviour worth pinning down.
 */

/**
 * What a dictation session needs to remember between results.
 *
 * The draft is always `typed + committed + segment`, and each field answers a
 * different question: `typed` is what cancelling falls back to, `committed` is
 * the utterances that are settled, `segment` is the one still open to revision.
 * Storing only the joined draft would make a revision indistinguishable from a
 * new sentence, which is the whole problem.
 */
export interface DictationState {
  /** The draft as it stood when the mic was tapped. */
  typed: string;
  /** Utterances the recogniser has finished with, joined. */
  committed: string;
  /** The utterance still open to revision. */
  segment: string;
  /** Whether `segment` was announced final, so the next result may open a new one. */
  closed: boolean;
}

export function beginDictation(draft: string): DictationState {
  return { typed: draft, committed: "", segment: "", closed: false };
}

/**
 * Join two fragments the way a person would.
 *
 * Dictating onto existing text inserts a space, because someone who typed
 * "fix the" and then said "login bug" means two words, not one. Text that
 * already ends in whitespace, or an opening bracket, is left as written.
 */
function join(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return left + (/[\s([{"'`]$/.test(left) ? "" : " ") + right;
}

function draftOf(state: DictationState): string {
  return join(join(state.typed, state.committed), state.segment);
}

/**
 * Whether `spoken` is the open segment being revised rather than a new utterance.
 *
 * Revisions grow from the front: "open" → "open the" → "Open the file." So a
 * prefix match in either direction is a revision — either direction because a
 * recogniser also *shortens* a guess it decided was wrong. Trailing punctuation
 * and case are ignored, since the recogniser adds both when finalising: reading
 * "open the" → "Open the file." as a new sentence is what duplicates text.
 *
 * A correction that rewrites a word mid-sentence ("the write approach" → "the
 * right approach") shares no prefix and is read as a new utterance. That is
 * deliberate, not an oversight: nothing in the result distinguishes it from a
 * genuinely new sentence, and the two mistakes are not equal. Appending leaves
 * a visible stutter the user can edit; replacing deletes speech they gave us,
 * which is the bug this file exists to prevent.
 */
function revises(segment: string, spoken: string): boolean {
  if (!segment) return true;
  const normalise = (text: string) => text.toLowerCase().replace(/[\s.,!?;:]+$/, "");
  const previous = normalise(segment);
  const next = normalise(spoken);
  if (!previous) return true;
  return next.startsWith(previous) || previous.startsWith(next);
}

/**
 * The draft after this transcript, and the state to carry forward.
 *
 * `isFinal` only closes the open segment; it never moves text by itself. A
 * closed segment is still revised in place when the next result turns out to
 * extend it, which is what makes iOS 18's repeated finals harmless.
 */
export function applyTranscript(
  state: DictationState,
  transcript: string,
  isFinal = false,
): { draft: string; state: DictationState } {
  const spoken = transcript.trim();
  if (!spoken) return { draft: draftOf(state), state };

  // A new utterance only when the open one is closed *and* this is not a late
  // revision of it.
  const next: DictationState =
    state.closed && !revises(state.segment, spoken)
      ? {
          ...state,
          committed: join(state.committed, state.segment),
          segment: spoken,
          closed: isFinal,
        }
      : { ...state, segment: spoken, closed: isFinal || state.closed };

  return { draft: draftOf(next), state: next };
}

/**
 * The draft to keep when dictation is cancelled rather than finished.
 *
 * Interim results are guesses; abandoning a recording should leave what was
 * typed before it, not a half-heard sentence the user never approved. That
 * means `typed` alone — `committed` is finalised speech, which is exactly what
 * cancelling is meant to throw away.
 */
export function cancelDictation(state: DictationState): string {
  return state.typed;
}

/**
 * What to tell the user when recognition fails.
 *
 * The codes follow the Web Speech API, which both native backends are mapped
 * onto. Anything unrecognised gets the generic line rather than a raw code:
 * "error: audio-capture" in a composer helps nobody.
 */
export function dictationMessage(code: string, detail?: string): string {
  switch (code) {
    // The recogniser closed the mic with no result and no error of its own.
    // Samsung's default (Bixby) does this on a continuous session; the name
    // is included because which service answered is the whole diagnosis.
    case "ended-early":
      return `Speech recognition stopped before hearing anything${detail ? ` (${detail})` : ""}. Try again, or change the voice recognition service in Android settings.`;
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone or speech access is off for pew2. Turn it on in Settings to dictate.";
    case "no-speech":
      return "Didn't catch that.";
    case "audio-capture":
      return "No microphone available.";
    case "network":
      return "Speech recognition needs a connection right now.";
    case "language-not-supported":
      return "That language isn't available for dictation on this device.";
    case "busy":
      return "Speech recognition is busy. Try again in a moment.";
    // "aborted" is what a deliberate stop reports; it is not a failure and must
    // not put a message on screen.
    case "aborted":
      return "";
    default:
      return "Dictation stopped unexpectedly.";
  }
}
