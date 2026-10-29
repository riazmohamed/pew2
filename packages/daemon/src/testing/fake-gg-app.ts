/**
 * A fake GG Coder desktop app implementing the phone control contract
 * (`app-desk.ts`), on a real local port: for the client and daemon tests.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface FakeWindow {
  sessionId: string;
  cwd: string;
  mode: string;
  sessionPath: string | null;
  agentSessionId: string | null;
  busy: boolean;
  focused: boolean;
  composer: string;
  /** v1.1: the plan waiting for a decision, and plan mode. */
  plan?: { planPath: string; content: string; generation: number } | null;
  planMode?: boolean;
  /** v1.2: open ask_user questions, oldest first. */
  asks?: { id: string; questions: unknown[] }[];
}

export interface FakeApp {
  port: number;
  token: string;
  file: string;
  windows: FakeWindow[];
  /** Every authorised request, in order. */
  calls: { route: string; body: Record<string, unknown> }[];
  /** What `/phone/open` answers with for a fresh conversation's agent id. */
  freshAgentSessionId: string | null;
  /** The conversation an accepted plan starts (null: the same one). */
  acceptAgentSessionId: string | null;
  /** Push an SSE event to every listener. */
  emit(event: unknown): void;
  /** Drop every event stream (the app quitting). */
  dropStreams(): void;
  stop(): void;
}

export async function startFakeApp(): Promise<FakeApp> {
  const token = "a".repeat(64);
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let next = 1;
  const app: FakeApp = {
    port: 0,
    token,
    file: "",
    windows: [],
    calls: [],
    freshAgentSessionId: null,
    acceptAgentSessionId: null,
    emit(event) {
      for (const stream of streams)
        stream.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    dropStreams() {
      for (const stream of streams) stream.close();
      streams.clear();
    },
    stop() {
      app.dropStreams();
      void server.stop(true);
    },
  };
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/phone/")) return json({ error: "not found" }, 404);
      if (request.headers.get("x-gg-phone-token") !== token)
        return json({ error: "unauthorized" }, 401);
      const route = url.pathname.slice("/phone/".length);
      const body =
        request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
      app.calls.push({ route, body });
      if (route === "ping") return json({ ok: true, appVersion: "0.97.5" });
      if (route === "windows")
        return json({ windows: app.windows.map(({ composer: _c, ...w }) => w) });
      if (route === "events") {
        let mine: ReadableStreamDefaultController<Uint8Array> | undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              mine = controller;
              streams.add(controller);
              controller.enqueue(encoder.encode(": ping\n\n"));
            },
            cancel() {
              if (mine) streams.delete(mine);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (route === "open") {
        const agentSessionId = typeof body.agentSessionId === "string" ? body.agentSessionId : null;
        const existing = agentSessionId
          ? app.windows.find((w) => w.agentSessionId === agentSessionId)
          : undefined;
        const window: FakeWindow = existing ?? {
          sessionId: `win-${next++}`,
          cwd: String(body.cwd),
          mode: typeof body.mode === "string" ? body.mode : "code",
          sessionPath: typeof body.sessionPath === "string" ? body.sessionPath : null,
          agentSessionId: agentSessionId ?? app.freshAgentSessionId,
          busy: false,
          focused: true,
          composer: "",
        };
        if (!existing) app.windows.push(window);
        app.emit({ type: "windows" });
        return json({
          sessionId: window.sessionId,
          sessionPath: window.sessionPath,
          agentSessionId: window.agentSessionId,
        });
      }
      const window = app.windows.find((w) => w.sessionId === body.sessionId);
      if (!window) return json({ error: "unknown session" }, 404);
      if (route === "draft") window.composer = String(body.text);
      else if (route === "send") window.composer = "";
      else if (route === "close") {
        app.windows = app.windows.filter((w) => w !== window);
        app.emit({ type: "closed", sessionId: window.sessionId });
        app.emit({ type: "windows" });
      } else if (route === "plan") {
        if (!window.plan) return json({ error: "no plan" }, 409);
        if (typeof body.generation === "number" && body.generation !== window.plan.generation)
          return json({ error: "stale plan" }, 409);
        window.plan = null;
        window.planMode = body.decision === "feedback";
        app.emit({ type: "plan", sessionId: window.sessionId, plan: null });
        if (body.decision === "accept" && app.acceptAgentSessionId) {
          window.agentSessionId = app.acceptAgentSessionId;
          window.sessionPath = null;
          app.emit({ type: "windows" });
        }
        return json({ ok: true, agentSessionId: window.agentSessionId });
      } else if (route === "ask") {
        const open = window.asks?.find((a) => a.id === body.id);
        if (!open) return json({ error: "no question is awaiting an answer" }, 409);
        window.asks = window.asks?.filter((a) => a !== open);
        app.emit({ type: "ask_closed", sessionId: window.sessionId, ids: [open.id] });
      } else if (route !== "abort") return json({ error: "not found" }, 404);
      return json({ ok: true });
    },
  });
  app.port = server.port ?? 0;
  const dir = await mkdtemp(path.join(tmpdir(), "pew2-ggapp-"));
  app.file = path.join(dir, "gg-app-phone.json");
  await writeFile(
    app.file,
    JSON.stringify({ version: 1, port: app.port, token, pid: process.pid, appVersion: "0.97.5" }),
    { mode: 0o600 },
  );
  return app;
}
