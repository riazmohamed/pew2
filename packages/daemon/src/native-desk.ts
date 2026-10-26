/**
 * Open a conversation in the agent's *own* terminal app, with the phone still
 * typing into it.
 *
 * Only iTerm can do this: its AppleScript `write text … newline NO` types into
 * a session by id without pressing Enter, which is what lets a phone draft
 * appear live in OG Coder's input. Terminal can only run a line, so it is not
 * offered (the `pew2 chat` window stays the answer there).
 *
 * Pure builders plus a small typing queue; the daemon owns the session side.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { shellQuote } from "./cli/chat-window.js";
import { APPLESCRIPT_TIMEOUT_MS, ITERM_APP, explainAppleScript, PENDING_NOTE } from "./desk.js";
import { folderName } from "./workspace.js";

/** Agents whose own CLI can resume a conversation by id, and how. */
export const NATIVE_APPS: Record<string, { name: string; resumeArgs: (id: string) => string[] }> = {
  ggcoder: { name: "OG Coder", resumeArgs: (id) => ["--resume", id] },
};

/** How often a native window is checked for still being there. */
export const NATIVE_ALIVE_POLL_MS = 3_000;

/** Phone keystrokes are typed at most this often (each one is an osascript). */
export const NATIVE_DRAFT_THROTTLE_MS = 100;

/** Control keys, as OG Coder's InputArea reads them. */
export const KEYS = {
  /** Ctrl-E: cursor to the end of the (one-line) input. */
  end: "\u0005",
  /** Ctrl-U: kill from the cursor to the start, so after Ctrl-E the whole input. */
  killLine: "\u0015",
  enter: "\r",
  /** Esc aborts a running turn (InputArea: `disabled` + escape → onAbort). */
  cancel: "\u001b",
  /** One character back. Each must be its own write (see CLEAR). */
  backspace: "\u007f",
  /** Ctrl-D on an empty input: OG Coder exits, as it does by hand. */
  quit: "\u0004",
  /** Ctrl-C: `pew2 chat` exits (its input is raw, so this reaches it as a key). */
  interrupt: "\u0003",
  /** Shift+Tab: OG Coder cycles its thinking level. */
  shiftTab: "\u001b[Z",
} as const;

/**
 * Longest change typed key by key. Ink reads a multi-character write as a
 * paste, and a paste interleaved with edits left OG Coder's input holding a
 * "[Pasted text]" block instead of what the phone shows; so ordinary typing
 * and deleting go one key per write. Beyond this (a pasted paragraph, a
 * restored draft) one clear-and-write is faster than hundreds of writes.
 */
export const KEY_BY_KEY_LIMIT = 40;

/**
 * Which providers may be opened natively here: macOS, iTerm installed, and the
 * agent's command found. Absent from the announcement otherwise.
 */
export function nativeProviders(
  providers: { id: string; commandMissing: boolean }[],
  env: { platform: NodeJS.Platform; hasITerm: boolean },
): string[] {
  if (env.platform !== "darwin" || !env.hasITerm) return [];
  return providers
    .filter((p) => !p.commandMissing && NATIVE_APPS[p.id] !== undefined)
    .map((p) => p.id)
    .sort();
}

/** The shell line the window runs: the agent, resumed, in the project. */
export function nativeCommand(
  command: string,
  providerId: string,
  agentSessionId: string | undefined,
  cwd: string,
): string {
  const app = NATIVE_APPS[providerId];
  if (!app) throw new Error(`No native app for '${providerId}'`);
  // No id: a new conversation, the app started plain in the project.
  const resume = agentSessionId ? app.resumeArgs(agentSessionId) : [];
  return ["cd", shellQuote(cwd), "&&", "exec", shellQuote(command), ...resume.map(shellQuote)].join(
    " ",
  );
}

/** AppleScript string literal. */
function appleString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * An AppleScript expression for arbitrary text, control characters included:
 * `"abc" & (character id 21) & "def"`.
 */
export function appleText(value: string): string {
  const parts: string[] = [];
  let run = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      if (run) parts.push(appleString(run));
      run = "";
      parts.push(`(character id ${code})`);
    } else {
      run += char;
    }
  }
  if (run || parts.length === 0) parts.push(appleString(run));
  return parts.join(" & ");
}

/** Open an iTerm window running `command`; the script returns the session id. */
export function nativeOpenScript(command: string, title: string): string {
  const shell = `/bin/zsh -lc ${shellQuote(command)}`;
  return [
    'tell application "iTerm"',
    `  set newWindow to (create window with default profile command ${appleString(shell)})`,
    "  set newSession to current session of newWindow",
    `  tell newSession to set name to ${appleString(title)}`,
    "  activate",
    "  return id of newSession",
    "end tell",
  ].join("\n");
}

function findSession(sessionId: string, body: string[]): string[] {
  return [
    'tell application "iTerm"',
    "  repeat with aWindow in windows",
    "    repeat with aTab in tabs of aWindow",
    "      repeat with aSession in sessions of aTab",
    `        if (id of aSession) is ${appleString(sessionId)} then`,
    ...body.map((line) => `          ${line}`),
    "        end if",
    "      end repeat",
    "    end repeat",
    "  end repeat",
    '  return "gone"',
    "end tell",
  ];
}

/** One typing step: text into the session without pressing Enter. */
export type Keystrokes = string[];

/**
 * Empty OG Coder's input. Two separate writes: Ink reads one write as one key
 * event, so control keys sharing a write with text were taken as literal
 * characters (a stray vertical tab showed as a line break).
 */
export const CLEAR: Keystrokes = [KEYS.end, KEYS.killLine];

/**
 * The keystrokes that turn the input from `typed` into `next`: just the new
 * tail when it only grew (letter-by-letter typing), else clear and retype.
 */
export function draftSteps(typed: string | undefined, next: string): Keystrokes {
  if (typed === undefined) return next ? [...CLEAR, ...bulkOrKeys(next)] : [...CLEAR];
  const was = [...typed];
  const now = [...next];
  let common = 0;
  while (common < was.length && common < now.length && was[common] === now[common]) common++;
  const removed = was.length - common;
  const added = now.slice(common);
  if (removed === 0 && added.length === 0) return [];
  if (next === "") return [...CLEAR];
  if (removed + added.length > KEY_BY_KEY_LIMIT) return [...CLEAR, ...bulkOrKeys(next)];
  return [...Array<string>(removed).fill(KEYS.backspace), ...added];
}

/** Short text key by key; long text as one write. */
function bulkOrKeys(text: string): Keystrokes {
  const chars = [...text];
  return chars.length > KEY_BY_KEY_LIMIT ? [text] : chars;
}

/**
 * Type into an iTerm session by id. Each step is written with `newline NO`; a
 * short pause before Enter lets the input settle so it is not read as a paste.
 */
export function nativeWriteScript(sessionId: string, steps: Keystrokes): string {
  const body: string[] = [];
  steps.forEach((step, index) => {
    // Each step must reach the app as its own read (see CLEAR).
    // Enter, and anything after a multi-character write, waits out OG Coder's
    // 100ms paste window so the paste is settled first; single keys go faster.
    if (index > 0) {
      const settle =
        step === KEYS.enter ||
        ([...(steps[index - 1] ?? "")].length > 1 && steps[index - 1] !== KEYS.shiftTab);
      body.push(settle ? "delay 0.15" : "delay 0.03");
    }
    body.push(`tell aSession to write text ${appleText(step)} newline NO`);
  });
  body.push('return "ok"');
  return findSession(sessionId, body).join("\n");
}

/** Closes the session's window outright (the fallback when a polite quit was ignored). */
export function nativeCloseScript(sessionId: string): string {
  return findSession(sessionId, ["close aSession", 'return "ok"']).join("\n");
}

/** Returns the end of the session's screen text, or "gone". */
export function nativeReadScript(sessionId: string): string {
  return findSession(sessionId, [
    "set c to contents of aSession",
    "set n to (count of c)",
    "if n > 8000 then set c to text (n - 7999) thru n of c",
    "return c",
  ]).join("\n");
}

/** How often an open OG Coder window is read back for desk-side edits. */
export const NATIVE_READ_POLL_MS = 800;

/** After the phone typed, how long the screen is left to settle before it counts. */
export const NATIVE_READ_QUIET_MS = 1_200;

/** What OG Coder's screen says, as far as pew2 can read it. Absent: not readable. */
export interface DeskScreen {
  /** The input box's text; "" when it shows the placeholder. */
  input?: string;
  /** The status line's model label (OG Coder's short name, e.g. "Opus"). */
  model?: string;
  /** "off", "low", … as the status line shows it. */
  thinking?: string;
  plan?: boolean;
  /**
   * The status row above the input: `busy` while the spinner runs, `idle` once
   * it shows a finished turn (`✻ …`), "Ready to go" or the stall warning.
   * Absent when that row cannot be read.
   */
  status?: "busy" | "idle";
}

const SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●] /;
const IDLE_STATUS = /^(✻ |⠿ Ready to go|⚠ API provider stream interrupted)/;

const PLACEHOLDER_TEXT = "Type your message or / to run a command";
const EDGE = /^\s*([▄▀─])\1{9,}\s*$/;

/**
 * Read OG Coder's input box and status line off its screen text.
 *
 * The input is the last ` > ` line sitting under an input edge (a run of
 * `▄`/`─`), plus its `   ` continuation lines up to the closing edge. Trailing
 * spaces are padding and cannot be told from typed ones, so callers compare
 * with `trimEnd()`. A collapsed paste (`[Pasted text #…]`) is unreadable and
 * yields no input at all.
 */
export function parseOgCoderScreen(contents: string): DeskScreen {
  const lines = contents.split(/\r?\n/);
  const screen: DeskScreen = {};

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith(" > ")) continue;
    const above = lines.slice(Math.max(0, i - 3), i);
    if (!above.some((l) => EDGE.test(l))) continue;
    // The status row sits directly above the input's top edge.
    let edge = i - 1;
    while (edge >= 0 && !EDGE.test(lines[edge]!)) edge--;
    const row = (lines[edge - 1] ?? "").trim();
    if (IDLE_STATUS.test(row)) screen.status = "idle";
    else if (SPINNER.test(row)) screen.status = "busy";
    const parts = [line.slice(3)];
    for (let j = i + 1; j < lines.length && !EDGE.test(lines[j]!); j++) {
      const next = lines[j]!;
      if (!next.startsWith("   ")) break;
      parts.push(next.slice(3));
    }
    const text = parts
      .map((p) => p.trimEnd())
      .join(" ")
      .trimEnd();
    if (!text.includes("[Pasted text #")) {
      screen.input = text.trim() === PLACEHOLDER_TEXT ? "" : text;
    }
    break;
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes("│") || !/Thinking \S+/.test(line)) continue;
    const cells = line.split("│").map((c) => c.trim());
    const planAt = cells.findIndex((c) => /^Plan (on|off)$/.test(c));
    const thinking = cells.map((c) => /^Thinking (\S+)$/.exec(c)?.[1]).find(Boolean);
    if (thinking) screen.thinking = thinking;
    if (planAt >= 0) {
      screen.plan = cells[planAt] === "Plan on";
      const model = cells[planAt - 1];
      if (model && !/%$/.test(model)) screen.model = model;
    }
    break;
  }
  return screen;
}

/** Selectors updated to what OG Coder's status line shows. */
export function applyDeskScreen<
  T extends {
    id: string;
    name?: string;
    category?: string | null;
    currentValue?: unknown;
    options?: { value: string; name?: string }[];
  },
>(options: T[], screen: DeskScreen): { options: T[]; changed: boolean } {
  let changed = false;
  const next = options.map((option) => {
    const values = option.options ?? [];
    let value: string | undefined;
    if (option.category === "model" && screen.model) {
      const label = screen.model.toLowerCase();
      const word = new RegExp(`\\b${screen.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      value = (
        values.find(
          (v) => v.value.toLowerCase() === label || (v.name ?? "").toLowerCase() === label,
        ) ?? values.find((v) => word.test(v.name ?? "") || word.test(v.value))
      )?.value;
    } else if (option.category === "thought_level" && screen.thinking) {
      value = values.find((v) => v.value === screen.thinking)?.value;
    } else if (option.category === "mode" && screen.plan !== undefined) {
      value = values.find((v) => /plan/i.test(v.value) === screen.plan)?.value;
    }
    if (value === undefined || value === option.currentValue) return option;
    changed = true;
    return { ...option, currentValue: value };
  });
  return { options: next, changed };
}

/** Returns the session's tty, or "gone". */
export function nativeAliveScript(sessionId: string): string {
  return findSession(sessionId, ["return tty of aSession"]).join("\n");
}

/** A phone message, made typeable: one line (Enter would send it early). */
export function typeable(text: string): string {
  return text.replace(/\r\n?|\n/g, " ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

export interface OsaResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** osascript with stdout. Killed on timeout, so a late window never opens. */
export function runOsa(
  script: string,
  timeoutMs: number = APPLESCRIPT_TIMEOUT_MS,
): Promise<OsaResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (result: OsaResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn("/usr/bin/osascript", ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) =>
      finish({ code: -1, stdout, stderr: String(error), timedOut: false }),
    );
    child.on("spawn", () => {});
    child.on("exit", (code) => finish({ code, stdout, stderr, timedOut: false }));
  });
}

/** What is running on a tty, by command name. */
function ttyCommands(tty: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("/bin/ps", ["-o", "comm=", "-t", tty.replace(/^\/dev\//, "")], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.stdout?.on("data", (chunk) => (out += String(chunk)));
    child.on("error", () => resolve(undefined));
    child.on("spawn", () => {});
    child.on("exit", () =>
      resolve(
        out
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    );
  });
}

const SHELLS = /(^|\/)-?(zsh|bash|sh|fish|login)$/;

export interface NativeDeskDeps {
  osa: (script: string, timeoutMs?: number) => Promise<OsaResult>;
  ttyCommands: (tty: string) => Promise<string[] | undefined>;
  hasITerm: () => boolean;
}

export const defaultNativeDeps = (): NativeDeskDeps => ({
  osa: runOsa,
  ttyCommands,
  hasITerm: () => existsSync(ITERM_APP),
});

/** Open the window; on success, the iTerm session id to type into. */
export async function openNativeWindow(
  deps: NativeDeskDeps,
  options: { command: string; providerId: string; agentSessionId?: string; cwd: string },
): Promise<{ ok: true; itermSessionId: string } | { ok: false; message: string }> {
  const app = NATIVE_APPS[options.providerId];
  const title = `${app?.name ?? options.providerId} · ${folderName(options.cwd) ?? options.cwd}`;
  const line = nativeCommand(
    options.command,
    options.providerId,
    options.agentSessionId,
    options.cwd,
  );
  const outcome = await deps.osa(nativeOpenScript(line, title));
  const id = outcome.stdout.trim();
  if (outcome.code === 0 && id) return { ok: true, itermSessionId: id };
  const why = explainAppleScript(outcome);
  if (why.kind === "pending") return { ok: false, message: PENDING_NOTE };
  if (why.kind === "denied") {
    return {
      ok: false,
      message:
        "pew2 isn't allowed to control iTerm. Allow it in System Settings › Privacy & Security › Automation › bun › iTerm.",
    };
  }
  // iTerm hands back no window when the command quit before it could be
  // read: the app itself would not start (most often, not found).
  if (/missing value/.test(why.detail)) {
    return {
      ok: false,
      message: `${app?.name ?? "The app"} closed as soon as it opened. Check it starts from a new iTerm window on your Mac.`,
    };
  }
  return { ok: false, message: `Couldn't open ${app?.name ?? "the app"}: ${why.detail}` };
}

/** Whether the window is still there with the agent running in it. */
export async function nativeAlive(deps: NativeDeskDeps, itermSessionId: string): Promise<boolean> {
  const outcome = await deps.osa(nativeAliveScript(itermSessionId), 8_000);
  // Unknown (iTerm busy, osascript slow) is not proof of an exit.
  if (outcome.code !== 0) return true;
  const tty = outcome.stdout.trim();
  if (tty === "gone") return false;
  if (!tty) return true;
  const commands = await deps.ttyCommands(tty);
  if (commands === undefined) return true;
  return commands.some((command) => !SHELLS.test(command));
}

/**
 * The typing side of one native window: drafts throttled to the latest text,
 * everything written in order, one osascript at a time.
 */
export class NativeTyper {
  private chain: Promise<unknown> = Promise.resolve();
  private pendingDraft?: string;
  /** What this typer last left in the input (undefined: unknown, so clear first). */
  private typed?: string;
  /** Writes queued or running, and when the last one finished. */
  private inFlight = 0;
  private lastWriteAt = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly itermSessionId: string,
    private readonly osa: NativeDeskDeps["osa"],
    private readonly throttleMs: number = NATIVE_DRAFT_THROTTLE_MS,
  ) {}

  /** What the phone last left in OG Coder's input, as far as this typer knows. */
  get lastTyped(): string | undefined {
    return this.typed;
  }

  /**
   * True while typing is queued or happened within `quietMs`. The screen read
   * back meanwhile is mid-keystroke, so it is not evidence of a desk edit.
   */
  busy(quietMs: number, now = Date.now()): boolean {
    return this.inFlight > 0 || this.timer !== undefined || now - this.lastWriteAt < quietMs;
  }

  /** The input as read off the screen: the next phone edit diffs against it. */
  observe(text: string): void {
    this.typed = text;
  }

  /** Replace OG Coder's input with this text, without sending it. */
  draft(text: string): void {
    this.pendingDraft = typeable(text);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const latest = this.pendingDraft;
      this.pendingDraft = undefined;
      if (latest === undefined) return;
      const steps = draftSteps(this.typed, latest);
      this.typed = latest;
      if (steps.length > 0) void this.write(steps);
    }, this.throttleMs);
    this.timer.unref?.();
  }

  /** Replace the input with this text and press Enter. */
  prompt(text: string): Promise<boolean> {
    this.dropDraft();
    this.typed = "";
    return this.write([...CLEAR, typeable(text), KEYS.enter]);
  }

  cancel(): Promise<boolean> {
    return this.write([KEYS.cancel]);
  }

  /** Run one of OG Coder's own slash commands (e.g. `/model x`), then put any draft back. */
  command(text: string): Promise<boolean> {
    const draft = this.typed ?? "";
    this.dropDraft();
    this.typed = draft;
    const restore = draft ? bulkOrKeys(draft) : [];
    return this.write([...CLEAR, typeable(text), KEYS.enter, ...restore]);
  }

  /** Empty the input, then quit the app the way a person would. */
  quit(): Promise<boolean> {
    this.dropDraft();
    this.typed = "";
    return this.write([...CLEAR, KEYS.quit]);
  }

  /** Press Shift+Tab `times` times (thinking level), one write each. */
  shiftTab(times: number): Promise<boolean> {
    if (times <= 0) return Promise.resolve(true);
    return this.write(Array<string>(times).fill(KEYS.shiftTab));
  }

  stop(): void {
    this.dropDraft();
  }

  private dropDraft() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingDraft = undefined;
  }

  private write(steps: Keystrokes): Promise<boolean> {
    const steps_ = steps.filter((step) => step.length > 0);
    this.inFlight++;
    const run = this.chain.then(async () => {
      try {
        const outcome = await this.osa(nativeWriteScript(this.itermSessionId, steps_), 8_000);
        return outcome.code === 0 && outcome.stdout.trim() === "ok";
      } finally {
        this.inFlight--;
        this.lastWriteAt = Date.now();
      }
    });
    this.chain = run.catch(() => false);
    return run.catch(() => false);
  }
}
