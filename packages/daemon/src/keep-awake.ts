/**
 * Keep this machine from idle-sleeping while someone is using it remotely.
 *
 * A phone driving an agent is "using the Mac", but nothing on the Mac sees a
 * keystroke, so the OS idle timer fires mid-turn and the whole pipeline pauses
 * until someone opens the lid. This holds a sleep assertion only while there is
 * a reason to: a turn running, a permission waiting, or a client active in the
 * last ten minutes. Locking the screen is not sleep and never needed this.
 *
 * The assertion is a child process (`caffeinate`, `systemd-inhibit`), never a
 * system setting: when the child dies the assertion goes with it, and on macOS
 * `-w <pid>` ties it to this daemon so even a SIGKILL'd daemon cannot leave the
 * machine awake for ever.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { userProvidersDir } from "./providers/registry.js";
import { writeFileAtomic } from "./atomic-file.js";

/** A client frame this recent counts as someone using the machine. */
export const ACTIVITY_WINDOW_MS = 10 * 60 * 1000;
/** How often the pref and the activity window are re-checked. */
export const TICK_MS = 30 * 1000;

export interface AwakeInputs {
  enabled: boolean;
  supported: boolean;
  working: boolean;
  permissionPending: boolean;
  /** Last client frame, epoch ms. */
  lastClientAt?: number;
  now: number;
}

/** Why a sleep assertion should be held right now, or undefined if not. */
export function holdReason(inputs: AwakeInputs): string | undefined {
  if (!inputs.enabled || !inputs.supported) return undefined;
  if (inputs.working) return "agent working";
  if (inputs.permissionPending) return "permission pending";
  if (inputs.lastClientAt !== undefined && inputs.now - inputs.lastClientAt < ACTIVITY_WINDOW_MS) {
    return "client active";
  }
  return undefined;
}

export type AwakePlatform =
  | { supported: true; command: string; args: string[] }
  | { supported: false; reason: string };

/** How to hold an idle-sleep assertion on this platform, if there is a way. */
export function awakePlatform(
  platform: NodeJS.Platform,
  pid: number,
  which: (command: string) => string | undefined = findOnPath,
): AwakePlatform {
  if (platform === "darwin") {
    // `-i`: idle system sleep only. The display may still sleep, and a closed
    // lid on battery still sleeps — that is the OS, and correctly so.
    return { supported: true, command: "/usr/bin/caffeinate", args: ["-i", "-w", String(pid)] };
  }
  if (platform === "linux") {
    const inhibit = which("systemd-inhibit");
    if (!inhibit) return { supported: false, reason: "systemd-inhibit was not found on this machine." };
    return {
      supported: true,
      command: inhibit,
      args: [
        "--what=idle",
        "--who=pew2",
        "--why=An agent is in use from another device",
        "--mode=block",
        "sleep",
        "infinity",
      ],
    };
  }
  return { supported: false, reason: `Keeping ${platform === "win32" ? "Windows" : platform} awake is not supported yet.` };
}

function findOnPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** `keep-awake.json`, beside the other prefs in `~/.pew2` (or `$PEW2_HOME`). */
export function keepAwakePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(userProvidersDir(env)), "keep-awake.json");
}

/** The user's switch. Missing or corrupt reads as on, the default. */
export async function readKeepAwakeEnabled(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(keepAwakePath(env), "utf8"));
    const enabled = (parsed as { enabled?: unknown } | null)?.enabled;
    return typeof enabled === "boolean" ? enabled : true;
  } catch {
    return true;
  }
}

export async function writeKeepAwakeEnabled(
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = keepAwakePath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify({ enabled }, null, 2)}\n`);
}

export interface KeepAwakeStatus {
  supported: boolean;
  enabled: boolean;
  active: boolean;
  reason?: string;
}

/** The narrow surface of a child this needs, so a test can fake it. */
export interface AwakeChild {
  on(event: "error" | "spawn" | "exit", listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type AwakeSpawn = (command: string, args: string[]) => AwakeChild;

export interface KeepAwakeOptions {
  platform: AwakePlatform;
  state: () => { working: boolean; permissionPending: boolean; lastClientAt?: number };
  readEnabled: () => Promise<boolean>;
  writeEnabled: (enabled: boolean) => Promise<void>;
  /** Called when supported/enabled/active changes. */
  onChange?: (status: KeepAwakeStatus) => void;
  spawn?: AwakeSpawn;
  now?: () => number;
  log?: (message: string) => void;
}

const defaultSpawn: AwakeSpawn = (command, args) =>
  nodeSpawn(command, args, { stdio: "ignore" }) as ChildProcess;

export class KeepAwake {
  private enabled = true;
  private child?: AwakeChild;
  private timer?: ReturnType<typeof setInterval>;
  private last: KeepAwakeStatus;
  /** Never holds anything until `start`, so a Daemon built in a test is inert. */
  private started = false;

  constructor(private readonly options: KeepAwakeOptions) {
    this.last = this.status;
  }

  get status(): KeepAwakeStatus {
    const platform = this.options.platform;
    return {
      supported: platform.supported,
      enabled: this.enabled,
      active: this.child !== undefined,
      ...(!platform.supported && { reason: platform.reason }),
    };
  }

  /** Read the pref, evaluate, and keep doing so on an unref'd interval. */
  async start(): Promise<void> {
    this.started = true;
    await this.tick();
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  /** Re-read the pref (so the CLI can flip it with no restart), then evaluate. */
  async tick(): Promise<void> {
    try {
      this.enabled = await this.options.readEnabled();
    } catch {
      // Keep the last known value.
    }
    this.evaluate();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    await this.options.writeEnabled(enabled);
    this.evaluate();
  }

  /** Hold or release to match the policy right now. Cheap; call freely. */
  evaluate(): void {
    const platform = this.options.platform;
    const reason = holdReason({
      enabled: this.enabled && this.started,
      supported: platform.supported,
      ...this.options.state(),
      now: (this.options.now ?? Date.now)(),
    });
    if (reason && !this.child && platform.supported) this.hold(platform.command, platform.args, reason);
    else if (!reason && this.child) this.release();
    this.changed();
  }

  /** Release and stop ticking. For shutdown. */
  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.child) this.release();
  }

  private hold(command: string, args: string[], reason: string) {
    const log = this.options.log ?? console.log;
    let child: AwakeChild;
    try {
      child = (this.options.spawn ?? defaultSpawn)(command, args);
    } catch (error) {
      log(`[awake] could not hold: ${(error as Error).message}`);
      return;
    }
    this.child = child;
    // Both listeners: an unresolvable command emits `error` asynchronously, and
    // unhandled it would take the daemon down with every session.
    child.on("error", (error) => {
      log(`[awake] could not hold: ${(error as Error)?.message ?? String(error)}`);
      if (this.child === child) {
        this.child = undefined;
        this.changed();
      }
    });
    child.on("spawn", () => {});
    child.on("exit", () => {
      // Died on its own (killed externally): forget it, so the next evaluate
      // holds again if there is still a reason to.
      if (this.child === child) {
        this.child = undefined;
        this.changed();
      }
    });
    log(`[awake] holding (${reason})`);
  }

  private release() {
    const child = this.child;
    this.child = undefined;
    try {
      child?.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    (this.options.log ?? console.log)("[awake] released");
  }

  private changed() {
    const next = this.status;
    const prev = this.last;
    if (next.supported === prev.supported && next.enabled === prev.enabled && next.active === prev.active) return;
    this.last = next;
    this.options.onChange?.(next);
  }
}
