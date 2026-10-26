/**
 * A call's trace for the daemon's log (`app.diag`): what the phone's audio
 * and the call did, and when, so a lock-screen call can be looked at after it.
 *
 * States and times only, never words from the call. Pure, so it is tested
 * under bun; `useVoice` owns the buffer and sends it.
 */

/** The daemon takes at most this many lines per message (`AppDiag`). */
export const TRACE_BATCH = 60;
/** And this long a line. */
const LINE_MAX = 280;

/** Seconds since the call started, then the text, made safe for one log line. */
export function traceLine(startedAt: number, now: number, text: string): string {
  const at = `+${Math.max(0, (now - startedAt) / 1000).toFixed(2)}s`;
  // Printable ASCII only (the schema refuses anything else): a newline in a
  // reason string from iOS must not split one line into two.
  const safe = text.replace(/[^\x20-\x7E]/g, "?");
  return `${at} ${safe}`.slice(0, LINE_MAX);
}

/** The lines in batches the daemon will take. */
export function traceBatches(lines: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < lines.length; i += TRACE_BATCH) out.push(lines.slice(i, i + TRACE_BATCH));
  return out;
}

/** The server events worth a line: Pew's voice starting and stopping, and it hearing the user. */
export const TRACED_SERVER_EVENTS: ReadonlySet<string> = new Set([
  "output_audio_buffer.started",
  "output_audio_buffer.stopped",
  "output_audio_buffer.cleared",
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
]);
