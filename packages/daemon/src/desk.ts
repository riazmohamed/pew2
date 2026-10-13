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
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { openWindowScript, windowCommand } from "./cli/chat-window.js";
import { isCompiled } from "./cli/service.js";

export interface DeskStatus {
  available: boolean;
  reason?: string;
}

export interface DeskResult {
  ok: boolean;
  app?: string;
  message?: string;
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
export function deskArgs(target: { sessionId?: string; cwd?: string }): string[] {
  if (!target.sessionId) return ["--all"];
  return [
    ...(target.cwd ? ["--project", target.cwd] : ["--all"]),
    "--focus",
    target.sessionId,
  ];
}

/** What an osascript failure means, for the phone. */
export function explainAppleScript(outcome: { code: number | null; stderr: string; timedOut: boolean }):
  | { kind: "denied" }
  | { kind: "pending" }
  | { kind: "failed"; detail: string } {
  if (outcome.timedOut) return { kind: "pending" };
  if (/-1743|not authori[sz]ed|Not authorised/i.test(outcome.stderr)) return { kind: "denied" };
  return { kind: "failed", detail: outcome.stderr.trim().split("\n").pop() ?? `exit ${outcome.code}` };
}

export const DENIED_NOTE =
  "Opened in Terminal. To use iTerm instead, allow it on your Mac: System Settings › Privacy & Security › Automation › bun › iTerm.";
export const PENDING_NOTE =
  "Your Mac is asking whether pew2 may control iTerm. Click OK there and the window opens.";

interface Deps {
  runAppleScript: (script: string, timeoutMs: number) => Promise<{ code: number | null; stderr: string; timedOut: boolean }>;
  openCommandFile: (command: string) => Promise<void>;
  hasITerm: () => boolean;
  now: () => number;
}

function runAppleScript(script: string, timeoutMs: number) {
  return new Promise<{ code: number | null; stderr: string; timedOut: boolean }>((resolve) => {
    let stderr = "";
    let timedOut = false;
    const child = spawn("/usr/bin/osascript", ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      // Left running on purpose: a pending permission prompt still delivers
      // the event once answered, so the window opens without a second tap.
      timedOut = true;
      resolve({ code: null, stderr, timedOut });
    }, timeoutMs);
    timer.unref?.();
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!timedOut) resolve({ code: -1, stderr: String(error), timedOut: false });
    });
    child.on("spawn", () => {});
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!timedOut) resolve({ code, stderr, timedOut: false });
    });
  });
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

export class Desk {
  private recent = new Map<string, number>();
  private readonly deps: Deps;

  constructor(deps: Partial<Deps> = {}) {
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

  async open(
    target: { sessionId?: string; cwd?: string },
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
      const outcome = await this.deps.runAppleScript(openWindowScript("iterm", command), APPLESCRIPT_TIMEOUT_MS);
      if (outcome.code === 0) return { ok: true, app: "iTerm" };
      const why = explainAppleScript(outcome);
      if (why.kind === "pending") return { ok: false, message: PENDING_NOTE };
      if (why.kind === "failed") console.error(`[desk] iTerm failed: ${why.detail}`);
      try {
        await this.deps.openCommandFile(command);
        return { ok: true, app: "Terminal", message: why.kind === "denied" ? DENIED_NOTE : undefined };
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
