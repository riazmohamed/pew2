/**
 * `pew2 chat` opens in a window of its own.
 *
 * Run inline, the chat took over the terminal it was started from, and the
 * only ways out (Ctrl-C, `/quit`) were nowhere on screen — so it read as a
 * terminal you could not leave. A window of its own leaves the user's shell
 * alone and closes itself when the chat ends.
 *
 * Pure: builds the command and the AppleScript. `chat.ts` runs them.
 */

/** Flag the spawned window runs with, so it does not open yet another window. */
export const HERE_FLAG = "--here";

/** Environment the chat depends on, forwarded so a test daemon is reached too. */
const FORWARDED_ENV = ["PEW2_PORT", "PEW2_HOME"] as const;

/** POSIX single-quoting: safe for any path, including spaces and quotes. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell command the new window runs: this same pew2, inline.
 *
 * Under `bun run` the runtime is `process.execPath` and the script is
 * `argv[1]`; a compiled binary is just `execPath`. `exec` so the window's
 * shell is replaced and ends with the chat.
 */
export function windowCommand(options: {
  execPath: string;
  script?: string;
  compiled: boolean;
  args: string[];
  env: Record<string, string | undefined>;
}): string {
  const env = FORWARDED_ENV.flatMap((name) => {
    const value = options.env[name];
    return value ? [`${name}=${shellQuote(value)}`] : [];
  });
  const program =
    options.compiled || !options.script ? [options.execPath] : [options.execPath, options.script];
  const args = options.args.filter((arg) => arg !== HERE_FLAG);
  return [
    "exec",
    ...(env.length ? ["env", ...env] : []),
    ...program.map(shellQuote),
    "chat",
    HERE_FLAG,
    ...args.map(shellQuote),
  ].join(" ");
}

export type TerminalApp = "iterm" | "terminal";

/**
 * Which app to open the window in: the one the user ran this from when that is
 * iTerm, otherwise Terminal (always present on macOS).
 */
export function pickTerminal(env: Record<string, string | undefined>): TerminalApp {
  return env.TERM_PROGRAM === "iTerm.app" ? "iterm" : "terminal";
}

/** AppleScript string literal. */
function appleString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * AppleScript that opens the window and runs `command` in it.
 *
 * iTerm: a new window whose session runs a login shell with the command, so
 * the window closes when the chat ends. Terminal: `do script` in a new window;
 * the trailing `exec` means the shell ends with the chat, and Terminal's
 * default profile closes a window whose shell exited cleanly.
 */
export function openWindowScript(app: TerminalApp, command: string): string {
  if (app === "iterm") {
    const shell = `/bin/zsh -lc ${shellQuote(command)}`;
    return [
      'tell application "iTerm"',
      `  create window with default profile command ${appleString(shell)}`,
      "  activate",
      "end tell",
    ].join("\n");
  }
  return [
    'tell application "Terminal"',
    `  do script ${appleString(command)}`,
    "  activate",
    "end tell",
  ].join("\n");
}
