/**
 * Open a conversation in the GG Coder *desktop app*, with the phone still
 * typing into it.
 *
 * The app exposes a small local control API while its "Phone control" setting
 * is on (`~/.gg/gg-app-phone.json` names the port and token; see the contract
 * in the goal folder, `phone-control-contract.md`). This module is the client
 * side: discovery, a JSON + Server-Sent Events client, and `AppTyper`, the
 * app's twin of `NativeTyper`. Replies, tool steps and turns are not on this
 * API: the app writes the same `.jsonl` as OG Coder, so `GgCoderMirror` reads
 * them back exactly as it does for an iTerm window.
 */
import { readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { NATIVE_DRAFT_THROTTLE_MS } from "./native-desk.js";

/** The name the phone is shown for this target. */
export const APP_NAME = "GG Coder app";

/** Providers whose conversations the app can open, sorted. */
export const APP_PROVIDERS = ["gg-goals", "ggcoder"] as const;

/** How often the discovery file is re-checked without a change to it. */
export const APP_RECHECK_MS = 10_000;

/** Ordinary requests; opening a window waits for its session to exist. */
export const APP_REQUEST_TIMEOUT_MS = 5_000;
export const APP_OPEN_TIMEOUT_MS = 20_000;

/** What the app wrote to its discovery file. */
export interface AppPhoneInfo {
  port: number;
  token: string;
  pid: number;
  appVersion?: string;
}

/** One app window, as `/phone/windows` lists it. */
export interface AppWindowInfo {
  sessionId: string;
  cwd: string;
  mode?: string;
  sessionPath: string | null;
  agentSessionId: string | null;
  busy: boolean;
  focused: boolean;
}

export type AppEvent =
  | { type: "draft"; sessionId: string; text: string }
  | { type: "windows" }
  | { type: "closed"; sessionId: string };

export type AppResult<T> = { ok: true; value: T } | { ok: false; status?: number; message: string };

/** `<GG_AGENT_DIR or ~/.gg>/gg-app-phone.json`. */
export function appPhoneFile(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return path.join(env.GG_AGENT_DIR || path.join(home, ".gg"), "gg-app-phone.json");
}

/** The discovery file's content, or undefined if it isn't one. */
export function parseAppPhoneFile(text: string): AppPhoneInfo | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const { port, token, pid, appVersion } = value;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65_535)
    return undefined;
  if (typeof token !== "string" || token.length === 0) return undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  return { port, token, pid, ...(typeof appVersion === "string" && { appVersion }) };
}

/** Whether a process is running (EPERM: it is, just not ours). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseEvent(raw: unknown): AppEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const event = raw as Record<string, unknown>;
  if (event.type === "windows") return { type: "windows" };
  if (typeof event.sessionId !== "string") return undefined;
  if (event.type === "closed") return { type: "closed", sessionId: event.sessionId };
  if (event.type === "draft" && typeof event.text === "string")
    return { type: "draft", sessionId: event.sessionId, text: event.text };
  return undefined;
}

function parseWindow(raw: unknown): AppWindowInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const w = raw as Record<string, unknown>;
  if (typeof w.sessionId !== "string" || typeof w.cwd !== "string") return undefined;
  return {
    sessionId: w.sessionId,
    cwd: w.cwd,
    ...(typeof w.mode === "string" && { mode: w.mode }),
    sessionPath: typeof w.sessionPath === "string" ? w.sessionPath : null,
    agentSessionId: typeof w.agentSessionId === "string" ? w.agentSessionId : null,
    busy: w.busy === true,
    focused: w.focused === true,
  };
}

/** The app's `/phone/*` API, one discovery file's worth. */
export class AppClient {
  constructor(
    readonly info: AppPhoneInfo,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = APP_REQUEST_TIMEOUT_MS,
  ) {}

  private url(route: string): string {
    return `http://127.0.0.1:${this.info.port}/phone/${route}`;
  }

  private async request(
    route: string,
    body?: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<AppResult<unknown>> {
    try {
      const response = await this.fetchImpl(this.url(route), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-gg-phone-token": this.info.token,
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const value: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const error =
          value &&
          typeof value === "object" &&
          typeof (value as { error?: unknown }).error === "string"
            ? (value as { error: string }).error
            : `HTTP ${response.status}`;
        return { ok: false, status: response.status, message: error };
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async ping(): Promise<boolean> {
    const result = await this.request("ping");
    return result.ok && (result.value as { ok?: unknown } | undefined)?.ok === true;
  }

  /** Every open window; undefined when the app could not be asked. */
  async windows(): Promise<AppWindowInfo[] | undefined> {
    const result = await this.request("windows");
    if (!result.ok) return undefined;
    const list = (result.value as { windows?: unknown } | undefined)?.windows;
    if (!Array.isArray(list)) return undefined;
    return list.map(parseWindow).filter((w): w is AppWindowInfo => w !== undefined);
  }

  async open(body: {
    cwd: string;
    sessionPath?: string;
    agentSessionId?: string;
    mode?: "code" | "goal";
  }): Promise<
    AppResult<{ sessionId: string; sessionPath: string | null; agentSessionId: string | null }>
  > {
    const result = await this.request("open", body, APP_OPEN_TIMEOUT_MS);
    if (!result.ok) return result;
    const value = (result.value ?? {}) as Record<string, unknown>;
    if (typeof value.sessionId !== "string")
      return { ok: false, message: "The app didn't say which window it opened." };
    return {
      ok: true,
      value: {
        sessionId: value.sessionId,
        sessionPath: typeof value.sessionPath === "string" ? value.sessionPath : null,
        agentSessionId: typeof value.agentSessionId === "string" ? value.agentSessionId : null,
      },
    };
  }

  private async action(route: string, body: Record<string, string>): Promise<boolean> {
    return (await this.request(route, body)).ok;
  }

  draft(sessionId: string, text: string): Promise<boolean> {
    return this.action("draft", { sessionId, text });
  }

  send(sessionId: string, text: string): Promise<boolean> {
    return this.action("send", { sessionId, text });
  }

  abort(sessionId: string): Promise<boolean> {
    return this.action("abort", { sessionId });
  }

  close(sessionId: string): Promise<boolean> {
    return this.action("close", { sessionId });
  }

  /**
   * Follow `/phone/events` until `stop()` or the stream ends; `onEnd` runs
   * once either way (not after `stop()`).
   */
  events(onEvent: (event: AppEvent) => void, onEnd: () => void): { stop: () => void } {
    const controller = new AbortController();
    let stopped = false;
    void (async () => {
      try {
        const response = await this.fetchImpl(this.url("events"), {
          headers: { "x-gg-phone-token": this.info.token, accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, "");
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            if (!line.startsWith("data:")) continue;
            let raw: unknown;
            try {
              raw = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            const event = parseEvent(raw);
            if (event && !stopped) onEvent(event);
          }
        }
      } catch {
        // Dropped or stopped: either way the stream is over.
      } finally {
        if (!stopped) onEnd();
      }
    })();
    return {
      stop: () => {
        stopped = true;
        controller.abort();
      },
    };
  }
}

export interface AppDeskOptions {
  /** The discovery file (default `appPhoneFile()`). */
  file?: string;
  fetch?: typeof fetch;
  pidAlive?: (pid: number) => boolean;
  recheckMs?: number;
  /** Availability changed (after a check). */
  onChange?: (available: boolean) => void;
  /** Every event from the app, while it is available. */
  onEvent?: (event: AppEvent) => void;
}

/**
 * Whether the app can be driven right now, and its event stream while it can.
 * Inert until `start()`, so a Daemon built in a test touches nothing.
 */
export class AppDesk {
  private current?: AppClient;
  private stream?: { stop: () => void };
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private checking?: Promise<void>;
  private again = false;
  private started = false;
  readonly file: string;

  constructor(private readonly options: AppDeskOptions = {}) {
    this.file = options.file ?? appPhoneFile();
  }

  /** The client while the app is available. */
  get client(): AppClient | undefined {
    return this.current;
  }

  get available(): boolean {
    return this.current !== undefined;
  }

  /** Watch the file and re-check every ~10 s. Resolves after the first check. */
  start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      try {
        const name = path.basename(this.file);
        this.watcher = watch(path.dirname(this.file), (_event, changed) => {
          if (!changed || changed === name) void this.check();
        });
        this.watcher.on("error", () => {});
        this.watcher.unref?.();
      } catch {
        // No ~/.gg yet: the timer still finds the file once it appears.
      }
      this.timer = setInterval(() => void this.check(), this.options.recheckMs ?? APP_RECHECK_MS);
      this.timer.unref?.();
    }
    return this.check();
  }

  stop(): void {
    this.started = false;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stream?.stop();
    this.stream = undefined;
    this.current = undefined;
  }

  /** Read the file, check the pid and ping. Serialised; a check during one runs once more. */
  check(): Promise<void> {
    if (this.checking) {
      this.again = true;
      return this.checking;
    }
    this.checking = (async () => {
      do {
        this.again = false;
        await this.checkOnce();
      } while (this.again);
    })().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async checkOnce(): Promise<void> {
    const info = parseAppPhoneFile(await readFile(this.file, "utf8").catch(() => ""));
    const alive = info !== undefined && (this.options.pidAlive ?? pidAlive)(info.pid);
    const same =
      info !== undefined &&
      this.current !== undefined &&
      this.current.info.port === info.port &&
      this.current.info.token === info.token &&
      this.current.info.pid === info.pid;
    const client =
      alive && info ? (same ? this.current : new AppClient(info, this.options.fetch)) : undefined;
    const reachable = client ? await client.ping() : false;
    const next = reachable ? client : undefined;
    if (next === this.current) {
      if (next && !this.stream) this.follow(next);
      return;
    }
    const was = this.available;
    this.stream?.stop();
    this.stream = undefined;
    this.current = next;
    if (next) this.follow(next);
    if (was !== this.available || (was && next)) this.options.onChange?.(this.available);
  }

  private follow(client: AppClient) {
    this.stream = client.events(
      (event) => this.options.onEvent?.(event),
      () => {
        if (this.current !== client) return;
        this.stream = undefined;
        // Dropped: the app may have quit. Find out now, not in 10 s.
        void this.check();
      },
    );
  }
}

/**
 * The typing side of one app window: drafts throttled to the latest text,
 * every request sent in order, one at a time. The app takes text whole, so
 * there is no key-by-key typing as there is for iTerm.
 */
export class AppTyper {
  private chain: Promise<unknown> = Promise.resolve();
  private pendingDraft?: string;
  private typed?: string;
  private inFlight = 0;
  private lastWriteAt = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly client: () => AppClient | undefined,
    readonly sessionId: string,
    private readonly throttleMs: number = NATIVE_DRAFT_THROTTLE_MS,
  ) {}

  /** What the phone last left in the window's composer, as far as this typer knows. */
  get lastTyped(): string | undefined {
    return this.typed;
  }

  busy(quietMs: number, now = Date.now()): boolean {
    return this.inFlight > 0 || this.timer !== undefined || now - this.lastWriteAt < quietMs;
  }

  /** The composer as the app reported it (typed by hand at the desk). */
  observe(text: string): void {
    this.typed = text;
  }

  /** Replace the composer's text, without sending it. Latest text wins. */
  draft(text: string): void {
    this.pendingDraft = text;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const latest = this.pendingDraft;
      this.pendingDraft = undefined;
      if (latest === undefined || latest === this.typed) return;
      this.typed = latest;
      void this.run((client) => client.draft(this.sessionId, latest));
    }, this.throttleMs);
    this.timer.unref?.();
  }

  /** Send as if typed in the window and Enter pressed. */
  prompt(text: string): Promise<boolean> {
    this.dropDraft();
    this.typed = "";
    return this.run((client) => client.send(this.sessionId, text));
  }

  cancel(): Promise<boolean> {
    return this.run((client) => client.abort(this.sessionId));
  }

  /** Slash commands are not driven in the app (its pills are its own). */
  command(_text: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  shiftTab(_times: number): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** Close the window. */
  quit(): Promise<boolean> {
    this.dropDraft();
    this.typed = "";
    return this.run((client) => client.close(this.sessionId));
  }

  stop(): void {
    this.dropDraft();
  }

  private dropDraft() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingDraft = undefined;
  }

  private run(call: (client: AppClient) => Promise<boolean>): Promise<boolean> {
    this.inFlight++;
    const run = this.chain.then(async () => {
      try {
        const client = this.client();
        return client ? await call(client) : false;
      } finally {
        this.inFlight--;
        this.lastWriteAt = Date.now();
      }
    });
    this.chain = run.catch(() => false);
    return run.catch(() => false);
  }
}
