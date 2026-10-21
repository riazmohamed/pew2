/**
 * The GPT-Live call engine: the one the user preferred before the upstream
 * merge (21 Oct: "the older version was way better for calling").
 *
 * GPT-Live (full duplex) talks to the user; a stronger Responses model behind
 * it (`delegation.responses`) decides what to do and calls Pew's tools. The
 * daemon creates the session from the phone's WebRTC offer with the OpenAI
 * API key (a ChatGPT sign-in is refused: "Voice session access denied"),
 * attaches the sideband, runs every tool call the backend makes with the
 * same tool code as the realtime engine, and feeds GPT-Live the agents' news
 * as commentary. The phone only carries audio and shows captions.
 *
 * The key is only ever put in an Authorization header: never in a message,
 * a log line or an error.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname, userInfo } from "node:os";

export const OPENAI_BASE = "https://api.openai.com/v1";
export const LIVE_MODEL = "gpt-live-1";
export const DEFAULT_LIVE_VOICE = "vesper";
export const DEFAULT_BACKEND_MODEL = "gpt-6-luna";
/** A call closes on its own after this long, whatever is happening. */
export const LIVE_MAX_MS = 30 * 60_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LiveSettings {
  apiKey: string;
  voice: string;
  backendModel: string;
}

/**
 * The live engine's settings, or undefined when it can't run (no API key) or
 * is switched off (`"engine": "realtime"` in voice.json). `OPENAI_API_KEY` in
 * the daemon's environment wins over voice.json's `openaiApiKey`, the file
 * pew2's old `pew2 voice key` wrote.
 */
export async function readLiveSettings(configDir: string, env: NodeJS.ProcessEnv = process.env): Promise<LiveSettings | undefined> {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(join(configDir, "voice.json"), "utf8"));
    if (parsed && typeof parsed === "object") stored = parsed as Record<string, unknown>;
  } catch {
    // Missing or unreadable: no key from the file.
  }
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  if (stored.engine === "realtime") return undefined;
  const apiKey = text(env.OPENAI_API_KEY) ?? text(stored.openaiApiKey);
  if (!apiKey) return undefined;
  return { apiKey, voice: text(stored.voice) ?? DEFAULT_LIVE_VOICE, backendModel: text(stored.backendModel) ?? DEFAULT_BACKEND_MODEL };
}

/** pew2's config dir from the voice auth file's path. */
export function configDirOf(voiceAuthPath: string): string {
  return dirname(voiceAuthPath);
}

function safetyIdentifier(): string {
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    // No passwd entry: the host alone still distinguishes.
  }
  return createHash("sha256").update(`pew2:${hostname()}:${user}`).digest("hex");
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "OpenAI-Safety-Identifier": safetyIdentifier() };
}

/** What a failed session create means for the person holding the phone. */
export function describeStatus(status: number): string {
  if (status === 401) return "OpenAI didn't accept the API key on your computer.";
  if (status === 403 || status === 404) return "The OpenAI key on your computer doesn't have GPT-Live access.";
  if (status === 429) return "OpenAI is rate limiting the key, or its credit is used up.";
  if (status >= 500) return "OpenAI had a problem starting the call. Try again in a moment.";
  return `OpenAI refused the call (HTTP ${status}).`;
}

export const LIVE_INSTRUCTIONS = `You are Pew, the pew2 mascot: a calm, warm, short-spoken AI voice assistant for a developer's coding agents, which run on their computer. Speak British English. The user is usually away from their desk, often driving or walking, phone in a pocket. One or two short sentences per turn. Never read out code, ids, file paths or long lists; summarise. If asked, you're Pew, an AI; never claim to be human.

You are their voice to their coding agents (OG Coder, Claude Code and others). You can't see their computer, but the agents can, and your backend can reach them. So never say you can't see, read, review or check something: delegate it and pass back what comes.

Backchannel policy: light backchannels. Interruption policy: stop speaking when the user interrupts, and listen.

Delegation policy:
Backend tools:
- Send a message to the coding agent in any open chat, open or start a chat in a project, and read what the agents are doing or said.
- Answer an agent's question or approval with the option the user chose.
- Book or cancel a callback, change a chat's model, end the call.

Delegate to the backend when:
- They ask anything about their projects, code, documents, repos or agents: status, review, check, fix, build, explain, write, commit, "ask OG Coder", "tell it", "pass this on".
- They answer a question or approval, or ask to stop, switch model, call back later, or cancel a callback.
- They say goodbye or ask to hang up: delegate so the call really ends, and say a short goodbye.
- A correction changes work already passed on.

Do not delegate when:
- They're chatting or ask something general you can answer yourself.
- You need one short clarification (for example which project, when several are open and nothing says which).

The briefing is a snapshot from when the call started and goes stale. Whenever they ask what an agent did, what it said, or how it's doing, delegate so the backend checks now; never answer that from the briefing or memory.

When work goes to an agent, say so in a few words ("Sent to misa_docs."). Agents take seconds to many minutes. Never say work is done, fixed or passing until you're told the outcome. You'll be told when an agent you passed work to finishes or needs them; pass that on in a sentence or two at a natural pause.

Work they hand over rings them back when it's done, so once it's sent and nothing else is going on, offer to hang up ("I'll ring you when it's done."). Never hang up without them agreeing.

For a question or approval from an agent: say what it wants and the choices, then wait for their choice. Never pick for them.

Open the call yourself: one short line. If the briefing says why you're calling (a callback), say that. Else if something is waiting, lead with it. Else greet and name the project they called from, if the briefing names one ("Hey. What's up with misa_docs?").`;

export const BACKEND_INSTRUCTIONS = `## Voice conversation context
You are the backend for Pew, a voice assistant in a live call with a developer who is away from their computer. The transcript may contain misheard words, unfinished phrases and corrections; project names are often misheard, so match them loosely to the sessions below and use the latest context. Act on what they asked; if a needed detail is truly missing (which project, when several are open and nothing points to one), return what's missing instead of guessing.

## How to act
- Anything about their project, code, documents or the work goes to the agent with tell_agent, at once, close to their own words as a developer would type it. Don't add steps or requirements. Leave session_id out for the chat they called from or last worked with on this call.
- Always call get_status before answering how a chat is doing, what was done last or what it said: the briefing is old.
- To send to a project that already has an open chat, use tell_agent with that chat. start_chat only for a project with no open chat, or when they ask for a new chat.
- Callbacks: call_me_back (minutes, or when_done for a chat); cancel_callback to cancel. Work handed over on a call rings them back by itself when it's done.
- end_call when they say goodbye or want to hang up.
- Never answer an agent's question or approval unless the user clearly chose an option in this call.

## Return the result
Return short, speakable facts: what was sent and to which project, or the answer. No markdown, ids, code or long paths. After tell_agent the work has only started: never report it as done.

The full rules Pew follows, the tools' detail and the briefing:
`;

/**
 * The GPT-Live session. `full` is the realtime engine's own instructions and
 * briefing (`buildInstructions`), which the backend gets whole; GPT-Live gets
 * the briefing part as context. `tools` are the realtime tool definitions,
 * which are already in the Responses function shape.
 */
export function liveSessionConfig(settings: LiveSettings, full: string, briefing: string, tools: readonly unknown[]): Record<string, unknown> {
  return {
    model: LIVE_MODEL,
    instructions: `${LIVE_INSTRUCTIONS}\n\nBriefing (for you to know, not to read out):\n${briefing}`,
    audio: { output: { voice: settings.voice } },
    delegation: {
      type: "responses",
      responses: {
        model: settings.backendModel,
        instructions: `${BACKEND_INSTRUCTIONS}\n${full}`,
        tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        reasoning: { effort: "low" },
      },
    },
  };
}

export type CreateResult = { ok: true; liveSessionId: string; sdp: string } | { ok: false; error: string };

export async function createLiveSession(options: {
  apiKey: string;
  sdp: string;
  session: Record<string, unknown>;
  fetch?: FetchLike;
}): Promise<CreateResult> {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  let response: Response;
  try {
    response = await doFetch(`${OPENAI_BASE}/live/sessions`, {
      method: "POST",
      headers: { ...authHeaders(options.apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({ session: options.session, transport: { type: "webrtc", sdp: options.sdp } }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, error: "Your computer couldn't reach OpenAI. Check its internet connection." };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error(`[voice] live session create failed: HTTP ${response.status} ${body.slice(0, 500).replace(/sk-[A-Za-z0-9_*.-]+/g, "sk-[redacted]")}`);
    return { ok: false, error: describeStatus(response.status) };
  }
  const body = (await response.json().catch(() => undefined)) as { session?: { id?: unknown }; transport?: { sdp?: unknown } } | undefined;
  const id = body?.session?.id;
  const sdp = body?.transport?.sdp;
  if (typeof id !== "string" || typeof sdp !== "string") return { ok: false, error: "OpenAI answered the call in a shape pew2 doesn't recognise." };
  return { ok: true, liveSessionId: id, sdp };
}

/** The subset of a WebSocket this needs, so tests can hand in a fake. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type CreateSocket = (url: string, headers: Record<string, string>) => SocketLike;

export const defaultCreateSocket: CreateSocket = (url, headers) =>
  // Bun's WebSocket takes headers in a second-argument option the DOM type doesn't know.
  new WebSocket(url, { headers } as unknown as string[]) as unknown as SocketLike;

export type RunTool = (toolCallId: string, name: string, args: string) => Promise<{ output: string; hangUp?: boolean }>;

/** An append is capped at 500 tokens. */
const APPEND_MAX_CHARS = 1800;
const clamp = (text: string) => (text.length <= APPEND_MAX_CHARS ? text : `${text.slice(0, APPEND_MAX_CHARS - 1)}…`);

interface FunctionCall {
  call_id: string;
  name: string;
  arguments: string;
}

/**
 * One GPT-Live call, seen from the sideband: runs the backend's tool calls,
 * feeds news in, and ends the call when Pew says goodbye.
 */
export class LiveCall {
  private socket?: SocketLike;
  private outbox: string[] = [];
  private readonly pending = new Map<string, FunctionCall[]>();
  private readonly pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private hangupTimer?: ReturnType<typeof setTimeout>;
  private maxTimer?: ReturnType<typeof setTimeout>;
  private finished = false;
  private sequence = 0;
  /** Run collected calls if the backend's completion event never comes. */
  static PENDING_FALLBACK_MS = 1500;
  /** Between end_call and hanging up: the goodbye is said first. */
  static HANGUP_DELAY_MS = 3500;

  constructor(
    readonly callId: string,
    readonly liveSessionId: string,
    private readonly options: {
      runTool: RunTool;
      /** Pew said goodbye: the app should hang up. */
      onHangup: () => void;
      onFinished: () => void;
      log?: (line: string) => void;
      greeting?: string;
    },
  ) {}

  attach(apiKey: string, createSocket: CreateSocket = defaultCreateSocket): void {
    let socket: SocketLike;
    try {
      socket = createSocket(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(this.liveSessionId)}/attach`, authHeaders(apiKey));
    } catch {
      this.log("sideband failed to open");
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      for (const frame of this.outbox.splice(0)) socket.send(frame);
      this.log("sideband attached");
    };
    socket.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (parsed && typeof parsed === "object") void this.onEvent(parsed as Record<string, unknown>);
    };
    socket.onerror = () => {};
    socket.onclose = () => this.finish();
    // Pew speaks first (the docs' greeting sequence: once, after start).
    if (this.options.greeting) this.append("session.commentary.append", this.options.greeting);
    this.maxTimer = setTimeout(() => this.close(), LIVE_MAX_MS);
    this.maxTimer.unref?.();
  }

  get done(): boolean {
    return this.finished;
  }

  /** News about a chat: said aloud at a natural point (`speak`), or kept as context. */
  note(text: string, speak: boolean): void {
    this.append(speak ? "session.commentary.append" : "session.thinking.append", text);
  }

  /** Text from the call screen: their own words, or (context) what they did there. */
  typed(text: string, context: boolean): void {
    if (context) this.append("session.thinking.append", `On the call screen: ${text}`);
    else this.append("session.instructions.append", `They typed this on their phone instead of saying it. Take it as their words and act on it: "${text}"`);
  }

  private append(type: string, content: string): void {
    this.send({ type, event_id: this.eventId("ctx"), delegation_id: null, content: clamp(content) });
  }

  private eventId(prefix: string): string {
    return `pew2_${prefix}_${++this.sequence}`;
  }

  private send(frame: Record<string, unknown>): void {
    if (this.finished) return;
    const text = JSON.stringify(frame);
    if (this.socket && this.socket.readyState === 1) this.socket.send(text);
    else this.outbox.push(text);
  }

  private log(line: string): void {
    this.options.log?.(`[voice] live ${this.callId}: ${line}`);
  }

  private async onEvent(event: Record<string, unknown>): Promise<void> {
    switch (event.type) {
      case "response.event": {
        const inner = event.event as { type?: unknown; item?: { type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown } } | undefined;
        const key = typeof event.delegation_id === "string" ? event.delegation_id : "";
        if (inner?.type === "response.output_item.done" && inner.item?.type === "function_call") {
          const { call_id, name } = inner.item;
          if (typeof call_id !== "string" || typeof name !== "string") return;
          const list = this.pending.get(key) ?? [];
          list.push({ call_id, name, arguments: typeof inner.item.arguments === "string" ? inner.item.arguments : "{}" });
          this.pending.set(key, list);
          clearTimeout(this.pendingTimers.get(key));
          const timer = setTimeout(() => void this.runPending(key), LiveCall.PENDING_FALLBACK_MS);
          timer.unref?.();
          this.pendingTimers.set(key, timer);
        } else if (inner?.type === "response.completed" || inner?.type === "response.done") {
          await this.runPending(key);
        } else if (inner?.type === "response.failed") {
          this.log(`backend response failed ${JSON.stringify(inner).slice(0, 300)}`);
        }
        return;
      }
      case "error": {
        const error = event.error as { code?: unknown; message?: unknown } | undefined;
        const code = typeof error?.code === "string" ? error.code : "";
        const said = typeof error?.message === "string" ? error.message : "";
        this.log(`error ${code} ${said.slice(0, 300)}`);
        return;
      }
      case "session.closed":
        this.log("closed by OpenAI");
        this.finish();
        return;
      default:
        return;
    }
  }

  private async runPending(key: string): Promise<void> {
    clearTimeout(this.pendingTimers.get(key));
    this.pendingTimers.delete(key);
    const calls = this.pending.get(key);
    if (!calls || calls.length === 0) return;
    this.pending.delete(key);
    let hangUp = false;
    for (const call of calls) {
      let result: { output: string; hangUp?: boolean };
      try {
        result = await this.options.runTool(call.call_id, call.name, call.arguments || "{}");
      } catch (error) {
        result = { output: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) };
      }
      this.log(`tool ${call.name} ${call.arguments.slice(0, 160)} -> ${result.output.slice(0, 160)}`);
      hangUp ||= result.hangUp === true;
      this.send({ type: "response.item.create", event_id: this.eventId("tool"), item: { type: "function_call_output", call_id: call.call_id, output: result.output } });
    }
    this.send({ type: "response.create", event_id: this.eventId("continue") });
    if (hangUp && !this.hangupTimer) {
      this.hangupTimer = setTimeout(() => {
        this.options.onHangup();
        // The app hangs up and sends voice.end, which closes this; in case it doesn't:
        const fallback = setTimeout(() => this.close(), 5000);
        fallback.unref?.();
      }, LiveCall.HANGUP_DELAY_MS);
      this.hangupTimer.unref?.();
    }
  }

  /** End the session (the user hung up, or the time ran out). */
  close(): void {
    if (this.finished) return;
    this.send({ type: "session.close", event_id: this.eventId("close") });
    const socket = this.socket;
    const later = setTimeout(() => this.finish(), socket && socket.readyState === 1 ? 2000 : 0);
    later.unref?.();
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
    clearTimeout(this.hangupTimer);
    clearTimeout(this.maxTimer);
    this.outbox = [];
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onclose = null;
      try {
        socket.close(1000, "done");
      } catch {
        // Already gone.
      }
    }
    this.log("ended");
    this.options.onFinished();
  }
}
