/**
 * A pew2 client over the real protocol: the LAN WebSocket, the same sealed
 * `SecureChannel` envelopes, `hello` with a proof and catch-up cursors.
 *
 * The state kept is what the phone keeps for the things the soak checks, read
 * with the app's own pure functions where the app has one, so a regression in
 * the app's matching or folding shows here too:
 *  - `desk` from `providers`, and Close via `deskActions` / `openWindows`
 *    (`packages/app/src/deskChoice.ts`);
 *  - a session's agent id, set at `session.started` and never otherwise, as
 *    the app's reducer does;
 *  - plans via `readPlan` (`chunks.ts`) and the work card via `workProgress`;
 *  - tool steps (title, status, output text) from `tool_call` updates.
 */
import { SecureChannel, e2e, wire } from "@pew2/protocol";
import { readPlan, type PlanEntry } from "../../packages/app/src/chunks.ts";
import {
  deskActions,
  openWindows,
  type DeskAnnouncement,
} from "../../packages/app/src/deskChoice.ts";

export interface ToolView {
  title: string;
  status: string;
  output: string;
}

export interface SessionView {
  sessionId: string;
  providerId?: string;
  cwd?: string;
  /** As the phone holds it: from `session.started` only. */
  agentSessionId?: string;
  lastSeq: number;
  plan?: PlanEntry[];
  pendingPlan?: { planPath: string; generation: number } | null;
  planMode?: boolean;
  tools: Map<string, ToolView>;
  agentText: string;
  closed: boolean;
  /** When this client last heard the session go idle (`session.idle`, or a replay saying so). */
  idleAt?: number;
  /** When the last event for it arrived. Idle only counts if it came after this. */
  eventAt?: number;
}

export interface LogEntry {
  at: number;
  who: string;
  dir: "in" | "out" | "note";
  frame: unknown;
}

export class SoakClient {
  desk?: DeskAnnouncement;
  activeSessions: string[] = [];
  readonly sessions = new Map<string, SessionView>();
  /** The session on screen, as the phone follows it. */
  current?: string;
  connected = false;
  private ws?: WebSocket;
  private channel?: SecureChannel;
  private waiters: { match: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  private nextRequest = 1;

  constructor(
    readonly name: string,
    private readonly opts: {
      port: number;
      token: string;
      key: string;
      deviceId: string;
      log: (entry: LogEntry) => void;
    },
  ) {}

  async connect(): Promise<void> {
    const rootKey = e2e.fromHex(this.opts.key);
    const channel = new SecureChannel(rootKey, "app");
    this.channel = channel;
    const ws = new WebSocket(
      `ws://127.0.0.1:${this.opts.port}/?token=${encodeURIComponent(this.opts.token)}`,
    );
    this.ws = ws;
    const cursors: Record<string, number> = {};
    for (const [id, view] of this.sessions) if (!view.closed) cursors[id] = view.lastSeq;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: connect timed out`)), 10_000);
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            t: "hello",
            wire: wire.WIRE_VERSION,
            role: "app",
            deviceId: this.opts.deviceId,
            proof: channel.proof(this.opts.deviceId),
            cursors,
          }),
        );
      };
      ws.onmessage = (event) => {
        const raw = JSON.parse(String(event.data));
        if (raw.t !== "e") {
          this.opts.log({ at: Date.now(), who: this.name, dir: "in", frame: raw });
          if (raw.t === "error") reject(new Error(`${this.name}: ${raw.message}`));
          return;
        }
        const message = channel.open(raw);
        if (!message) return;
        this.receive(message);
        if ((message as { t?: string }).t === "device.joined" && !this.connected) {
          this.connected = true;
          clearTimeout(timer);
          resolve();
        }
      };
      ws.onclose = () => {
        this.connected = false;
      };
      ws.onerror = () => reject(new Error(`${this.name}: socket error`));
    });
  }

  /** Drop the socket, as a phone going through a tunnel does. */
  drop(): void {
    this.opts.log({ at: Date.now(), who: this.name, dir: "note", frame: { drop: true } });
    try {
      this.ws?.close();
    } catch {
      // Already gone.
    }
    this.connected = false;
  }

  send(message: Record<string, unknown>): void {
    if (!this.ws || !this.channel) throw new Error(`${this.name}: not connected`);
    this.opts.log({ at: Date.now(), who: this.name, dir: "out", frame: message });
    this.ws.send(JSON.stringify(this.channel.seal(message)));
  }

  /** Send and wait for the reply carrying the same request id. */
  async request(message: Record<string, unknown>, reply: string, timeoutMs = 20_000): Promise<any> {
    const requestId = `${this.name}-${this.nextRequest++}`;
    const answer = this.waitFor(
      (m) => m.t === reply && m.requestId === requestId,
      timeoutMs,
      `${reply} for ${String(message.t)}`,
    );
    this.send({ ...message, requestId });
    return answer;
  }

  waitFor(match: (m: any) => boolean, timeoutMs: number, what: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve: (m: any) => (clearTimeout(timer), resolve(m)) };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`${this.name}: timed out waiting for ${what}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** What the computer icon offers for the session on screen (the app's own function). */
  deskMenu(): ReturnType<typeof deskActions> {
    const view = this.current ? this.sessions.get(this.current) : undefined;
    return deskActions(this.desk, view?.providerId, view?.agentSessionId, this.current);
  }

  closeOffered(): boolean {
    const view = this.current ? this.sessions.get(this.current) : undefined;
    const open = openWindows(this.desk, view?.agentSessionId, this.current);
    return open.native || open.chat || open.app;
  }

  private view(sessionId: string): SessionView {
    let view = this.sessions.get(sessionId);
    if (!view) {
      view = { sessionId, lastSeq: 0, tools: new Map(), agentText: "", closed: false };
      this.sessions.set(sessionId, view);
    }
    return view;
  }

  private applyEvent(sessionId: string, seq: number, payload: any): void {
    const view = this.view(sessionId);
    if (seq <= view.lastSeq) return;
    view.lastSeq = seq;
    view.eventAt = Date.now();
    const update = payload?.update;
    const plan = readPlan(payload);
    if (plan) view.plan = plan;
    if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
      const id = String(update.toolCallId);
      const tool = view.tools.get(id) ?? { title: "", status: "", output: "" };
      if (typeof update.title === "string") tool.title = update.title;
      if (typeof update.status === "string") tool.status = update.status;
      for (const block of Array.isArray(update.content) ? update.content : []) {
        const text = block?.content?.text;
        if (typeof text === "string") tool.output += text;
      }
      view.tools.set(id, tool);
    }
    if (update?.sessionUpdate === "agent_message_chunk") {
      const content = update.content;
      for (const block of Array.isArray(content) ? content : [content])
        if (typeof block?.text === "string") view.agentText += block.text;
    }
  }

  private receive(message: any): void {
    this.opts.log({ at: Date.now(), who: this.name, dir: "in", frame: message });
    switch (message.t) {
      case "providers":
        this.desk = message.desk;
        this.activeSessions = message.activeSessions ?? [];
        break;
      case "session.started": {
        const view = this.view(message.sessionId);
        // The phone's reducer sets the agent id here and nowhere else.
        view.agentSessionId = message.agentSessionId ?? view.agentSessionId;
        view.providerId = message.providerId ?? view.providerId;
        view.cwd = message.cwd ?? view.cwd;
        view.closed = false;
        // A resumed conversation (moved into the app's window) takes the screen
        // over from the row that held it, as the phone swaps the row.
        const current = this.current ? this.sessions.get(this.current) : undefined;
        if (
          message.resumed &&
          current &&
          current.sessionId !== message.sessionId &&
          current.agentSessionId &&
          current.agentSessionId === message.agentSessionId
        )
          this.current = message.sessionId;
        break;
      }
      case "session.event":
        this.applyEvent(message.sessionId, message.seq, message.payload);
        break;
      case "session.idle":
        this.view(message.sessionId).idleAt = Date.now();
        break;
      case "session.replay":
        for (const event of message.events ?? [])
          this.applyEvent(message.sessionId, event.seq, event.payload);
        if (message.working === false) this.view(message.sessionId).idleAt = Date.now();
        if (message.plan !== undefined) {
          const view = this.view(message.sessionId);
          view.pendingPlan = message.plan?.pending ?? null;
          view.planMode = message.plan?.planMode;
        }
        break;
      case "plan.state": {
        const view = this.view(message.sessionId);
        view.pendingPlan = message.pending ?? null;
        view.planMode = message.planMode;
        break;
      }
      case "session.closed":
        this.view(message.sessionId).closed = true;
        break;
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.match(message)) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.resolve(message);
      }
    }
  }

  close(): void {
    this.drop();
  }
}
