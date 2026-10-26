/**
 * A time on every tagged log line.
 *
 * The daemon's log had none, so a question as plain as "what happened when I
 * tested last night" could not be answered from it: a relay drop at 23:00 and
 * one at 04:00 read the same, and nothing could be lined up against the phone,
 * the relay or the machine sleeping. Under launchd stdout is the log file, so
 * the stamp has to be added here; the service cannot do it.
 *
 * Only lines that open with a `[tag]` are stamped. Those are the daemon's own
 * messages; the rest is the startup banner (whose pairing QR code is drawn
 * line by line and would be broken by a prefix on its first row) and raw
 * values such as a stack trace, which belong to the tagged line before them.
 */

/** Local wall-clock time, `YYYY-MM-DD HH:MM:SS`, which is what the user reads off their own clock. */
export function logTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** The arguments with the first one stamped, if it is a tagged line. */
export function stampArgs(args: unknown[], now: Date): unknown[] {
  const [first, ...rest] = args;
  if (typeof first !== "string" || !first.startsWith("[")) return args;
  return [`${logTime(now)} ${first}`, ...rest];
}

/**
 * Stamp `console.log` and `console.error` for the rest of the process.
 *
 * Once only: installing twice would stamp twice. Returns the undo, for tests.
 */
export function installLogTimes(now: () => Date = () => new Date()): () => void {
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => log(...stampArgs(args, now()));
  console.error = (...args: unknown[]) => error(...stampArgs(args, now()));
  return () => {
    console.log = log;
    console.error = error;
  };
}
