/**
 * A fake GG Coder desktop app for the soak: the phone-control contract
 * (`~/.gg/goals/pew2-livestream/phone-control-contract.md`: v1 windows, v1.1
 * plans, v1.2 questions) on a real local port, writing conversation files and
 * plan files exactly where and how the real app does, so the daemon's mirror,
 * plan recovery and re-pointing run against the same shapes as in real use.
 *
 * It is also the ground truth: every tool step it writes and every plan step
 * it marks done is recorded, and the harness compares both clients to it.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { encodeCwd } from "../../packages/daemon/src/acp/ggcoder-history.ts";

export interface ToolTruth {
  toolCallId: string;
  title: string;
  output: string;
}

export interface AppWindow {
  sessionId: string;
  cwd: string;
  mode: string;
  sessionPath: string | null;
  agentSessionId: string | null;
  busy: boolean;
  focused: boolean;
  composer: string;
  plan: { planPath: string; content: string; generation: number } | null;
  planMode: boolean;
  asks: { id: string; questions: unknown[] }[];
  /** The conversation ids this window has run, oldest first (rotations). */
  history: string[];
  /** Ground truth for the harness. */
  tools: ToolTruth[];
  approved?: { planPath: string; steps: string[]; done: Set<number> };
  last: string | null;
}

export interface FakeApp {
  port: number;
  token: string;
  file: string;
  windows: AppWindow[];
  /** Every request, newest last (bounded), for failure dumps. */
  calls: { at: number; route: string; body: unknown; status: number }[];
  emit(event: unknown): void;
  /** GG Coder's compaction: carry on in a child conversation (`parentSessionId`). */
  compact(window: AppWindow): Promise<string>;
  /** Wait until no window is mid-turn. */
  idle(timeoutMs?: number): Promise<boolean>;
  /** Run one scripted turn in a window, as if typed at the desk; resolves when it ends. */
  runTurnFor(window: AppWindow, text: string): Promise<void>;
  snapshot(): unknown;
  stop(): void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFakeApp(options: {
  home: string;
  /** Pace of streamed writes, ms. */
  beatMs?: number;
}): Promise<FakeApp> {
  const token = crypto
    .getRandomValues(new Uint8Array(32))
    .reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  const encoder = new TextEncoder();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const beat = options.beatMs ?? 35;
  let nextWindow = 1;
  let counter = 0;
  let generation = 0;

  const sessionsDir = (cwd: string) => path.join(options.home, ".gg", "sessions", encodeCwd(cwd));

  function newConversation(
    window: AppWindow,
    first?: { text: string },
    parentSessionId?: string,
  ): string {
    const id = crypto.randomUUID();
    const dir = sessionsDir(window.cwd);
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}_${id.slice(0, 8)}.jsonl`);
    writeFileSync(
      file,
      `${JSON.stringify({
        type: "session",
        id,
        conversationId: id,
        cwd: window.cwd,
        timestamp: new Date().toISOString(),
        ...(parentSessionId && { parentSessionId }),
      })}\n`,
    );
    window.agentSessionId = id;
    window.sessionPath = file;
    window.history.push(id);
    window.last = null;
    if (first) message(window, "user", [{ type: "text", text: first.text }]);
    return id;
  }

  function line(window: AppWindow, entry: Record<string, unknown>): void {
    if (!window.sessionPath) return;
    appendFileSync(window.sessionPath, `${JSON.stringify(entry)}\n`);
  }

  function message(window: AppWindow, role: string, content: unknown): void {
    const id = `app-${++counter}`;
    line(window, {
      type: "message",
      id,
      parentId: window.last,
      timestamp: new Date().toISOString(),
      message: { role, content },
    });
    window.last = id;
  }

  function journal(window: AppWindow, kind: "run_started" | "run_finished"): void {
    line(window, {
      type: "custom",
      id: `app-${++counter}`,
      kind,
      data: {},
      timestamp: new Date().toISOString(),
    });
  }

  function writePlan(window: AppWindow, steps: string[]): { planPath: string; content: string } {
    const dir = path.join(window.cwd, ".gg", "plans");
    mkdirSync(dir, { recursive: true });
    const planPath = path.join(dir, `soak-plan-${generation + 1}.md`);
    const content = [
      `# Soak plan ${generation + 1}`,
      "",
      "## Goal",
      "Exercise the phone mirror.",
      "",
      "## Steps",
      ...steps.map((step, index) => `${index + 1}. ${step}`),
      "",
      "## Notes",
      "1. Not a step.",
      "",
    ].join("\n");
    writeFileSync(planPath, content);
    return { planPath, content };
  }

  /** One scripted turn, streamed as separate file writes like the real app. */
  async function runTurn(window: AppWindow, text: string): Promise<void> {
    window.busy = true;
    journal(window, "run_started");
    message(window, "user", [{ type: "text", text }]);
    await sleep(beat);
    const plan = /PLAN:(\d+):(\S+)/.exec(text);
    const work = /WORK:(\d+):(\S+)/.exec(text);
    const done = /DONE:(\d+)-(\d+)/.exec(text);
    if (plan) {
      const steps = Array.from(
        { length: Number(plan[1]) },
        (_, i) => `Soak step ${i + 1} of cycle ${plan[2]}`,
      );
      message(window, "assistant", [{ type: "text", text: "Here is the plan for your review." }]);
      const written = writePlan(window, steps);
      window.planMode = true;
      window.plan = { ...written, generation: ++generation };
      emit({ type: "plan", sessionId: window.sessionId, plan: window.plan });
    }
    if (work) {
      const steps = Number(work[1]);
      const nonce = work[2]!;
      for (let i = 1; i <= steps; i++) {
        const toolCallId = `app-tool-${nonce}-${i}`;
        const command = `echo step-${i}-${nonce}`;
        message(window, "assistant", [
          { type: "tool_call", id: toolCallId, name: "bash", args: { command } },
        ]);
        await sleep(beat);
        const output = `out-${i}-${nonce}`;
        message(window, "tool", [{ type: "tool_result", toolCallId, content: output }]);
        window.tools.push({ toolCallId, title: `bash(${command})`, output });
        await sleep(beat);
      }
    }
    if (done && window.approved) {
      for (let n = Number(done[1]); n <= Number(done[2]); n++) {
        if (n > window.approved.steps.length) break;
        message(window, "assistant", [{ type: "text", text: `Finished step ${n}. [DONE:${n}]` }]);
        window.approved.done.add(n);
        await sleep(beat);
      }
    }
    if (!plan) message(window, "assistant", [{ type: "text", text: `Done: ${text.slice(0, 30)}` }]);
    journal(window, "run_finished");
    window.busy = false;
  }

  function emit(event: unknown): void {
    for (const stream of streams) {
      try {
        stream.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      } catch {
        streams.delete(stream);
      }
    }
  }

  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const view = (w: AppWindow) => ({
    sessionId: w.sessionId,
    cwd: w.cwd,
    mode: w.mode,
    sessionPath: w.sessionPath,
    agentSessionId: w.agentSessionId,
    busy: w.busy,
    focused: w.focused,
    plan: w.plan,
    planMode: w.planMode,
    asks: w.asks,
  });

  const app: FakeApp = {
    port: 0,
    token,
    file: path.join(options.home, ".gg", "gg-app-phone.json"),
    windows: [],
    calls: [],
    emit,
    async compact(window) {
      const parent = window.agentSessionId ?? undefined;
      const id = newConversation(
        window,
        { text: "[Previous conversation summary] Soak work so far." },
        parent,
      );
      emit({ type: "windows" });
      return id;
    },
    async idle(timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!app.windows.some((w) => w.busy)) return true;
        await sleep(25);
      }
      return false;
    },
    runTurnFor(window, text) {
      return runTurn(window, text);
    },
    snapshot() {
      return app.windows.map((w) => ({
        ...view(w),
        history: w.history,
        tools: w.tools.length,
        approved: w.approved ? { ...w.approved, done: [...w.approved.done] } : undefined,
      }));
    },
    stop() {
      for (const stream of streams) {
        try {
          stream.close();
        } catch {
          // Already gone.
        }
      }
      streams.clear();
      void server.stop(true);
    },
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const route = url.pathname.replace(/^\/phone\//, "");
      const body =
        request.method === "POST"
          ? ((await request.json().catch(() => ({}))) as Record<string, any>)
          : {};
      const answer = (value: unknown, status = 200) => {
        app.calls.push({ at: Date.now(), route, body, status });
        if (app.calls.length > 400) app.calls.splice(0, app.calls.length - 400);
        return json(value, status);
      };
      if (!url.pathname.startsWith("/phone/")) return answer({ error: "not found" }, 404);
      if (request.headers.get("x-gg-phone-token") !== token)
        return answer({ error: "unauthorized" }, 401);
      if (route === "ping") return answer({ ok: true, appVersion: "soak" });
      if (route === "windows") return answer({ windows: app.windows.map(view) });
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
        const wanted = typeof body.agentSessionId === "string" ? body.agentSessionId : null;
        const existing = wanted ? app.windows.find((w) => w.agentSessionId === wanted) : undefined;
        if (existing) {
          existing.focused = true;
          return answer({
            sessionId: existing.sessionId,
            sessionPath: existing.sessionPath,
            agentSessionId: existing.agentSessionId,
          });
        }
        const window: AppWindow = {
          sessionId: `soak-win-${nextWindow++}`,
          cwd: String(body.cwd),
          mode: typeof body.mode === "string" ? body.mode : "code",
          sessionPath: typeof body.sessionPath === "string" ? body.sessionPath : null,
          agentSessionId: wanted,
          busy: false,
          focused: true,
          composer: "",
          plan: null,
          planMode: false,
          asks: [],
          history: wanted ? [wanted] : [],
          tools: [],
          last: null,
        };
        if (!wanted) newConversation(window);
        app.windows.push(window);
        emit({ type: "windows" });
        return answer({
          sessionId: window.sessionId,
          sessionPath: window.sessionPath,
          agentSessionId: window.agentSessionId,
        });
      }
      const window = app.windows.find((w) => w.sessionId === body.sessionId);
      if (!window) return answer({ error: "unknown session" }, 404);
      if (route === "draft") {
        window.composer = String(body.text ?? "");
        return answer({ ok: true });
      }
      if (route === "send") {
        window.composer = "";
        void runTurn(window, String(body.text ?? ""));
        return answer({ ok: true });
      }
      if (route === "abort") {
        window.busy = false;
        return answer({ ok: true });
      }
      if (route === "close") {
        app.windows = app.windows.filter((w) => w !== window);
        emit({ type: "closed", sessionId: window.sessionId });
        emit({ type: "windows" });
        return answer({ ok: true });
      }
      if (route === "plan") {
        if (!window.plan) return answer({ error: "no plan" }, 409);
        if (typeof body.generation === "number" && body.generation !== window.plan.generation)
          return answer({ error: "stale plan" }, 409);
        const pending = window.plan;
        window.plan = null;
        emit({ type: "plan", sessionId: window.sessionId, plan: null });
        if (body.decision === "accept") {
          window.planMode = false;
          const steps = [...pending.content.matchAll(/^(\d+)\. (Soak step .+)$/gm)].map(
            (m) => m[2]!,
          );
          window.approved = { planPath: pending.planPath, steps, done: new Set() };
          // GG Coder's accept starts a fresh conversation with this prompt.
          newConversation(window, {
            text: "The plan has been approved. Implement it now, step by step.",
          });
          emit({ type: "windows" });
          return answer({ ok: true, agentSessionId: window.agentSessionId });
        }
        if (body.decision === "reject") {
          window.planMode = false;
          message(window, "user", [{ type: "text", text: "The plan was rejected and dismissed." }]);
          return answer({ ok: true, agentSessionId: window.agentSessionId });
        }
        return answer({ ok: true, agentSessionId: window.agentSessionId });
      }
      if (route === "ask") {
        const open = window.asks.find((a) => a.id === body.id);
        if (!open) return answer({ error: "no question is awaiting an answer" }, 409);
        window.asks = window.asks.filter((a) => a !== open);
        emit({ type: "ask_closed", sessionId: window.sessionId, ids: [open.id] });
        return answer({ ok: true });
      }
      return answer({ error: "not found" }, 404);
    },
  });
  app.port = server.port ?? 0;
  mkdirSync(path.dirname(app.file), { recursive: true });
  writeFileSync(
    app.file,
    JSON.stringify({ version: 1, port: app.port, token, pid: process.pid, appVersion: "soak" }),
    { mode: 0o600 },
  );
  return app;
}
