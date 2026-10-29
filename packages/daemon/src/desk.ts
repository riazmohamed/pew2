/**
 * Open a `pew2 chat` window on this computer's screen, at the phone's request.
 *
 * The daemon runs headless (launchd), so it opens the window the way a person
 * would: iTerm through AppleScript when it is installed and allowed, otherwise
 * Terminal by opening a `.command` file, which needs no permission at all.
 * AppleScript from a launchd process is an Apple Event from `bun`, and macOS
 * asks once ("bun wants to control iTerm"); until that is answered the call
 * blocks, and a refusal is error -1743. Both are told to the phone in words,
 * and a refusal falls back to Terminal so the tap still does something.
 *
 * Nothing from the client reaches the command line except a session id this
 * daemon holds: the project is the session's own recorded cwd, and the program
 * is pew2 itself, quoted.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { openWindowScript, windowCommand } from "./cli/chat-window.js";
import { isCompiled } from "./cli/service.js";
import { wire } from "@pew2/protocol";

export interface DeskStatus {
  available: boolean;
  reason?: string;
}

export interface DeskResult {
  ok: boolean;
  app?: string;
  message?: string;
  /** The iTerm session it opened in, so it can be closed later. Never sent to a client. */
  itermSessionId?: string;
}

export const ITERM_APP = "/Applications/iTerm.app";

/** How long an AppleScript call may wait, e.g. on the one-time permission prompt. */
export const APPLESCRIPT_TIMEOUT_MS = 12_000;

/** Repeated taps on the same conversation within this window open one window. */
export const DESK_DEBOUNCE_MS = 4_000;

export function deskStatus(platform: NodeJS.Platform = process.platform): DeskStatus {
  return platform === "darwin"
    ? { available: true }
    : { available: false, reason: "Opening a window from the phone is macOS only for now." };
}

/** Arguments for the window: follow this session's project, starting on it. */
export function deskArgs(target: {
  sessionId?: string;
  cwd?: string;
  providerId?: string;
}): string[] {
  if (!target.sessionId) {
    // A new conversation: a window for that project, starting one with that agent.
    return target.cwd
      ? ["--project", target.cwd, ...(target.providerId ? ["--agent", target.providerId] : [])]
      : ["--all"];
  }
  return [...(target.cwd ? ["--project", target.cwd] : ["--all"]), "--focus", target.sessionId];
}

/** What an osascript failure means, for the phone. */
export function explainAppleScript(outcome: {
  code: number | null;
  stderr: string;
  timedOut: boolean;
}): { kind: "denied" } | { kind: "pending" } | { kind: "failed"; detail: string } {
  if (outcome.timedOut) return { kind: "pending" };
  if (/-1743|not authori[sz]ed|Not authorised/i.test(outcome.stderr)) return { kind: "denied" };
  return {
    kind: "failed",
    detail: outcome.stderr.trim().split("\n").pop() ?? `exit ${outcome.code}`,
  };
}

export const DENIED_NOTE =
  "Opened in Terminal. To use iTerm instead, allow it on your Mac: System Settings › Privacy & Security › Automation › bun › iTerm.";
export const PENDING_NOTE =
  "Your Mac is asking whether pew2 may control iTerm. Click OK there and the window opens.";

/** The OS calls `Desk` makes, replaceable for tests and `scripts/soak`. */
export interface DeskDeps {
  runAppleScript: (
    script: string,
    timeoutMs: number,
  ) => Promise<{ code: number | null; stderr: string; timedOut: boolean; stdout?: string }>;
  openCommandFile: (command: string) => Promise<void>;
  hasITerm: () => boolean;
  now: () => number;
}

function runAppleScript(script: string, timeoutMs: number) {
  return new Promise<{ code: number | null; stderr: string; timedOut: boolean; stdout: string }>(
    (resolve) => {
      let stderr = "";
      let stdout = "";
      let timedOut = false;
      const child = spawn("/usr/bin/osascript", ["-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        // Left running on purpose: a pending permission prompt still delivers
        // the event once answered, so the window opens without a second tap.
        timedOut = true;
        resolve({ code: null, stderr, timedOut, stdout });
      }, timeoutMs);
      timer.unref?.();
      child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", (error) => {
        clearTimeout(timer);
        if (!timedOut) resolve({ code: -1, stderr: String(error), timedOut: false, stdout });
      });
      child.on("spawn", () => {});
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (!timedOut) resolve({ code, stderr, timedOut: false, stdout });
      });
    },
  );
}

/**
 * Terminal opens a `.command` file and runs it, with no Automation prompt.
 * Written to a private directory and removed shortly after: Terminal reads it
 * at launch.
 */
async function openCommandFile(command: string): Promise<void> {
  const dir = join(tmpdir(), "pew2-desk");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `chat-${randomBytes(4).toString("hex")}.command`);
  await writeFile(file, `#!/bin/zsh -l\n${command}\n`, { mode: 0o700 });
  await chmod(file, 0o700);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/open", ["-a", "Terminal", file], { stdio: "ignore" });
    child.on("error", reject);
    child.on("spawn", () => {});
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`open exited ${code}`))));
  });
  const timer = setTimeout(() => void unlink(file).catch(() => {}), 60_000);
  timer.unref?.();
}

/** The pew2 CLI, as this daemon process can run it. */
function cliProgram(): { execPath: string; script?: string; compiled: boolean } {
  const compiled = isCompiled();
  return compiled
    ? { execPath: process.execPath, compiled }
    : {
        execPath: process.execPath,
        script: join(dirname(fileURLToPath(import.meta.url)), "cli", "index.ts"),
        compiled,
      };
}

/** iTerm: open the window like the CLI launcher does, and answer with its session id. */
export function itermOpenScript(command: string): string {
  return openWindowScript("iterm", command).replace(
    / {2}create window with default profile command (.+)\n {2}activate/,
    "  set newWindow to (create window with default profile command $1)\n  activate\n  return id of current session of newWindow",
  );
}

export class Desk {
  private recent = new Map<string, number>();
  private readonly deps: DeskDeps;

  constructor(deps: Partial<DeskDeps> = {}) {
    this.deps = {
      runAppleScript,
      openCommandFile,
      hasITerm: () => existsSync(ITERM_APP),
      now: () => Date.now(),
      ...deps,
    };
  }

  status(): DeskStatus {
    return deskStatus();
  }

  private capturing?: Promise<CaptureResult>;

  /**
   * A picture of the screen. Taps that land while one is being taken share
   * it, so a double tap is one capture, not two.
   */
  capture(capture: () => Promise<CaptureResult> = captureScreen): Promise<CaptureResult> {
    if (!this.status().available)
      return Promise.resolve({ ok: false, message: this.status().reason });
    this.capturing ??= capture().finally(() => {
      this.capturing = undefined;
    });
    return this.capturing;
  }

  async open(
    target: { sessionId?: string; cwd?: string; providerId?: string },
    env: Record<string, string | undefined> = process.env,
  ): Promise<DeskResult> {
    const status = this.status();
    if (!status.available) return { ok: false, message: status.reason };

    const key = target.sessionId ?? "";
    const last = this.recent.get(key);
    const now = this.deps.now();
    if (last !== undefined && now - last < DESK_DEBOUNCE_MS) {
      return { ok: true, message: "Already opening." };
    }
    this.recent.set(key, now);

    const command = windowCommand({ ...cliProgram(), args: deskArgs(target), env });

    if (this.deps.hasITerm()) {
      const outcome = await this.deps.runAppleScript(
        itermOpenScript(command),
        APPLESCRIPT_TIMEOUT_MS,
      );
      if (outcome.code === 0) {
        // Kept so the phone can close this window later; Terminal's are not.
        const id = outcome.stdout?.trim();
        return { ok: true, app: "iTerm", ...(id && { itermSessionId: id }) };
      }
      const why = explainAppleScript(outcome);
      if (why.kind === "pending") return { ok: false, message: PENDING_NOTE };
      if (why.kind === "failed") console.error(`[desk] iTerm failed: ${why.detail}`);
      try {
        await this.deps.openCommandFile(command);
        return {
          ok: true,
          app: "Terminal",
          message: why.kind === "denied" ? DENIED_NOTE : undefined,
        };
      } catch (error) {
        return { ok: false, message: `Couldn't open a window: ${String(error)}` };
      }
    }

    try {
      await this.deps.openCommandFile(command);
      return { ok: true, app: "Terminal" };
    } catch (error) {
      return { ok: false, message: `Couldn't open a window: ${String(error)}` };
    }
  }
}

export interface CaptureResult {
  ok: boolean;
  name?: string;
  mimeType?: string;
  data?: string;
  message?: string;
}

export const SCREEN_PERMISSION_NOTE =
  "pew2 isn't allowed to see the screen yet. On the Mac, open System Settings › Privacy & Security › Screen & System Audio Recording, turn on bun, then try again.";

/** Longest edge of the picture sent: sharp on a phone, a fraction of the bytes. */
export const CAPTURE_MAX_EDGE = 1800;

export type ToolRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; stderr: string }>;

const runTool: ToolRunner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    let stderr = "";
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stderr });
    };
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => {
      stderr += String(error);
      finish(-1);
    });
    child.on("spawn", () => {});
    child.on("exit", (code) => finish(code));
  });

function clock(now: Date): string {
  return `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
}

/**
 * The main display as a JPEG, read into memory and deleted from disk.
 *
 * `screencapture -x` (no shutter sound) writes a PNG in a private temp folder;
 * `sips` turns it into a JPEG no longer than `CAPTURE_MAX_EDGE` on its longest
 * side, so a 5K display arrives in well under a megabyte. Under launchd the
 * capture is the daemon's own (`bun`): macOS asks once for Screen Recording,
 * and until it is allowed the capture fails or comes back as wallpaper only.
 */
export async function captureScreen(
  deps: { run?: ToolRunner; now?: () => Date } = {},
): Promise<CaptureResult> {
  const run = deps.run ?? runTool;
  const dir = await mkdtemp(join(tmpdir(), "pew2-screen-"));
  try {
    const png = join(dir, "screen.png");
    const jpg = join(dir, "screen.jpg");
    const shot = await run("/usr/sbin/screencapture", ["-x", "-t", "png", png], 20_000);
    const size = await stat(png)
      .then((info) => info.size)
      .catch(() => 0);
    if (shot.code !== 0 || size === 0) {
      const detail = shot.stderr.trim().split("\n").pop();
      return {
        ok: false,
        message:
          /not (authori[sz]ed|permitted)|permission|could not create image/i.test(shot.stderr) ||
          !detail
            ? SCREEN_PERMISSION_NOTE
            : `Couldn't take the screenshot: ${detail}`,
      };
    }
    const shrink = await run(
      "/usr/bin/sips",
      [
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        "70",
        "-Z",
        String(CAPTURE_MAX_EDGE),
        png,
        "--out",
        jpg,
      ],
      20_000,
    );
    const useJpeg =
      shrink.code === 0 &&
      (await stat(jpg)
        .then((info) => info.size > 0)
        .catch(() => false));
    const bytes = await readFile(useJpeg ? jpg : png);
    if (bytes.length > wire.MAX_ATTACHMENT_BYTES) {
      return { ok: false, message: "The screenshot came out too large to send." };
    }
    const now = (deps.now ?? (() => new Date()))();
    return {
      ok: true,
      name: `mac-screen-${clock(now)}.${useJpeg ? "jpg" : "png"}`,
      mimeType: useJpeg ? "image/jpeg" : "image/png",
      data: bytes.toString("base64"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
