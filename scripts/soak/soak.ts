#!/usr/bin/env bun
/**
 * Soak / stress harness for pew2's GG Coder app mirroring.
 *
 *   bun scripts/soak/soak.ts            # 30 minutes
 *   bun scripts/soak/soak.ts --quick    # 2 minutes
 *   bun scripts/soak/soak.ts --minutes 10
 *
 * It starts an isolated pew2 daemon (own HOME, own PEW2_HOME, own port, its
 * own pairing token; never the launchd `dev.pew2.daemon`, never the real
 * phone pairing), a stub OG Coder agent (no model calls, no credits), a fake
 * GG Coder desktop app (the phone-control contract) and a fake iTerm, then
 * drives two real protocol clients, a "phone" and a "desktop" (`pew2 chat`
 * device), through cycles of:
 *
 *   start a chat -> open it in the GG Coder app -> open it in pew2 chat and in
 *   OG Coder too (three windows on one conversation) -> plan mode -> accept ->
 *   conversation id rotation (accept starts a new one) -> streamed tool steps
 *   -> [DONE:n] plan progress -> compaction (another rotation) -> drop and
 *   reconnect the phone -> close from the phone.
 *
 * After every cycle (and at the checkpoints inside one) it asserts the
 * invariants listed in INVARIANTS below. On the first failure it writes the
 * cycle, the full event log and a state diff to .gg/soak/<run>/ and exits 1.
 */
import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { pairingFromToken } from "../../packages/daemon/src/pairing.ts";
import { workProgress } from "../../packages/app/src/workProgress.ts";
import { SoakClient, type LogEntry } from "./client.ts";
import { startFakeApp, type AppWindow, type FakeApp } from "./fake-app.ts";

const REPO = path.resolve(import.meta.dir, "../..");
const args = process.argv.slice(2);
const quick = args.includes("--quick");
const minutesArg = args.indexOf("--minutes");
const minutes = minutesArg >= 0 ? Number(args[minutesArg + 1]) : quick ? 2 : 30;
const durationMs = Math.max(0.25, minutes) * 60_000;
const RUN = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = path.join(REPO, ".gg", "soak", RUN);
const ROOT = path.join("/tmp", `pew2-soak-${process.pid}`);
const HOME = path.join(ROOT, "home");
const PEW2_HOME = path.join(ROOT, "pew2");
const PROJECT = path.join(ROOT, "project");

const INVARIANTS = [
  "close-offered: the phone's own deskActions offers Close for a conversation open on the computer",
  "plan-parity: the phone and the desktop show the same plan steps (content and status) as the app",
  "tool-parity: both clients have every tool step the app ran, with the app's title and output",
  "one-agent: at most one agent process per conversation",
  "no-leaks: after Close, no window, mirror session or agent is left over",
  "memory: the daemon's RSS does not keep climbing",
  "settles: a finished turn reaches the phone as idle (a stuck 'working' blocks Close)",
];

// ---------------------------------------------------------------- logging

const events: LogEntry[] = [];
const MAX_EVENTS = 20_000;
function log(entry: LogEntry): void {
  events.push(entry);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}
/** How the daemon answered the requests that can go either way, counted per run. */
const outcomes = new Map<string, number>();
function tally(outcome: string): void {
  outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
}
const cycleTimes: number[] = [];

function note(what: string, detail?: unknown): void {
  log({
    at: Date.now(),
    who: "harness",
    dir: "note",
    frame: detail === undefined ? what : { what, detail },
  });
}
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
function say(line: string): void {
  console.log(`[soak ${stamp()}] ${line}`);
}

// ---------------------------------------------------------------- isolation

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

function prepareIsolation(): { token: string } {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(path.join(PEW2_HOME, "providers"), { recursive: true });
  mkdirSync(path.join(HOME, ".gg", "sessions"), { recursive: true });
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(path.join(ROOT, "agents"), { recursive: true });
  mkdirSync(OUT, { recursive: true });
  // The stub shadows the bundled ggcoder manifest (user dir wins), so the
  // daemon spawns it instead of `ogcoder`.
  writeFileSync(
    path.join(PEW2_HOME, "providers", "ggcoder.json"),
    JSON.stringify(
      {
        id: "ggcoder",
        name: "OG Coder",
        version: "0.0.0-soak",
        description: "Soak stub: no model calls.",
        distribution: {
          type: "command",
          command: process.execPath,
          args: ["run", path.join(import.meta.dir, "stub-agent.ts")],
        },
        license: "MIT",
        pew: { transport: "acp", color: "#4ade80" },
      },
      null,
      2,
    ),
  );
  // Every other bundled agent off: the soak daemon must not probe real ones.
  const bundled = readdirSync(path.join(REPO, "providers"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .filter((id) => id !== "ggcoder");
  writeFileSync(
    path.join(PEW2_HOME, "disabled.json"),
    JSON.stringify({ version: 2, disabled: bundled }),
  );
  writeFileSync(path.join(PEW2_HOME, "known-projects.json"), JSON.stringify([PROJECT]));
  // Keep-awake off: a soak must not hold a sleep assertion on this Mac.
  writeFileSync(path.join(PEW2_HOME, "keep-awake.json"), JSON.stringify({ enabled: false }));
  // A fixed throwaway token: `loadPairing` derives the pairing from it and
  // never touches a pairing file, so the real phone pairing is not read.
  const token = crypto
    .getRandomValues(new Uint8Array(32))
    .reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  return { token };
}

// ---------------------------------------------------------------- daemon

let daemon: Subprocess | undefined;
const daemonOut: string[] = [];

async function startDaemon(port: number, token: string): Promise<void> {
  const env = {
    ...process.env,
    HOME,
    PEW2_HOME,
    PEW2_PORT: String(port),
    PEW2_TOKEN: token,
    PEW2_RELAY: "",
    PEW2_EXPERIMENTAL: "",
    PEW2_SOAK_DIR: ROOT,
    PEW2_TEST_SEAMS: path.join(import.meta.dir, "seams.ts"),
    // No voice or model keys reach the isolated daemon.
    OPENAI_API_KEY: "",
    OPENROUTER_API_KEY: "",
  };
  daemon = spawn([process.execPath, "run", path.join(REPO, "packages/daemon/src/server.ts")], {
    cwd: REPO,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const pump = async (stream: ReadableStream<Uint8Array> | null | undefined, tag: string) => {
    if (!stream) return;
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(chunk).split("\n")) {
        if (!line.trim()) continue;
        daemonOut.push(`${new Date().toISOString()} ${tag} ${line}`);
        if (daemonOut.length > 5_000) daemonOut.splice(0, daemonOut.length - 5_000);
      }
    }
  };
  void pump(daemon.stdout as ReadableStream<Uint8Array>, "out");
  void pump(daemon.stderr as ReadableStream<Uint8Array>, "err");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await Bun.sleep(200);
  }
  throw new Error("isolated daemon did not come up in 30s");
}

function daemonRssKb(): number {
  if (!daemon?.pid) return 0;
  const result = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(daemon.pid)]);
  return Number(new TextDecoder().decode(result.stdout).trim()) || 0;
}

// ---------------------------------------------------------------- truth from the side processes

function liveAgents(): { pid: number; sessions: string[] }[] {
  const dir = path.join(ROOT, "agents");
  if (!existsSync(dir)) return [];
  const out: { pid: number; sessions: string[] }[] = [];
  for (const name of readdirSync(dir)) {
    try {
      const entry = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as {
        pid: number;
        sessions: string[];
      };
      try {
        process.kill(entry.pid, 0);
        out.push(entry);
      } catch {
        // Exited without cleaning up its marker: not alive, not counted.
      }
    } catch {
      // Being rewritten.
    }
  }
  return out;
}

function fakeIterm(): { id: string; command: string; open: boolean }[] {
  try {
    return (
      JSON.parse(readFileSync(path.join(ROOT, "fake-iterm.json"), "utf8")) as {
        windows: { id: string; command: string; open: boolean }[];
      }
    ).windows;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- invariants

class InvariantError extends Error {
  constructor(
    readonly invariant: string,
    message: string,
    readonly expected?: unknown,
    readonly actual?: unknown,
  ) {
    super(`[${invariant}] ${message}`);
  }
}

function check(
  condition: boolean,
  invariant: string,
  message: string,
  expected?: unknown,
  actual?: unknown,
): void {
  if (!condition) throw new InvariantError(invariant, message, expected, actual);
}

async function eventually(probe: () => void, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      probe();
      return;
    } catch (error) {
      last = error;
      await Bun.sleep(100);
    }
  }
  throw last;
}

// ---------------------------------------------------------------- the run

let phone!: SoakClient;
let desktop!: SoakClient;
let app!: FakeApp;
let cycle = 0;
let step = "setup";
const cyclePlan: string[] = [];
const rssSamples: { cycle: number; kb: number }[] = [];

function snapshot() {
  const describe = (client: SoakClient) => ({
    connected: client.connected,
    current: client.current,
    desk: client.desk,
    activeSessions: client.activeSessions,
    deskMenu: client.current ? client.deskMenu() : [],
    sessions: [...client.sessions.values()].map((view) => ({
      sessionId: view.sessionId,
      agentSessionId: view.agentSessionId,
      closed: view.closed,
      plan: view.plan,
      pendingPlan: view.pendingPlan,
      planMode: view.planMode,
      tools: Object.fromEntries(view.tools),
    })),
  });
  return {
    cycle,
    step,
    phone: describe(phone),
    desktop: describe(desktop),
    app: app.snapshot(),
    agents: liveAgents(),
    fakeIterm: fakeIterm(),
    rssKb: daemonRssKb(),
  };
}

/** Plain diff of two JSON values: paths whose values differ. */
function diff(a: unknown, b: unknown, at = "$", out: string[] = []): string[] {
  if (out.length > 400) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    out.push(`${at}: ${JSON.stringify(a)?.slice(0, 300)} -> ${JSON.stringify(b)?.slice(0, 300)}`);
    return out;
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const key of keys)
    diff(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      `${at}.${key}`,
      out,
    );
  return out;
}

/** The state at the last checkpoint that held (diffed against on failure). */
let lastGood: unknown;

function planAsShown(view: { plan?: { content: string; status: string }[] } | undefined) {
  return (view?.plan ?? []).map((entry) => `${entry.status}:${entry.content}`);
}

function appPlanTruth(window: AppWindow): string[] {
  const approved = window.approved;
  if (!approved) return [];
  let active = false;
  return approved.steps.map((content, index) => {
    if (approved.done.has(index + 1)) return `completed:${content}`;
    if (!active) {
      active = true;
      return `in_progress:${content}`;
    }
    return `pending:${content}`;
  });
}

async function assertParity(sessionId: string, window: AppWindow, label: string): Promise<void> {
  await assertParityChecks(sessionId, window, label);
  // A checkpoint that held: the state a later failure is diffed against.
  lastGood = snapshot();
}

async function assertParityChecks(
  sessionId: string,
  window: AppWindow,
  label: string,
): Promise<void> {
  step = `${label}: parity`;
  await eventually(() => {
    const truth = appPlanTruth(window);
    if (truth.length > 0) {
      for (const client of [phone, desktop]) {
        const shown = planAsShown(client.sessions.get(sessionId));
        check(
          JSON.stringify(shown) === JSON.stringify(truth),
          "plan-parity",
          `${client.name} plan steps differ from the app's`,
          truth,
          shown,
        );
      }
      // The phone's work card reads the same plan the same way.
      const view = phone.sessions.get(sessionId)!;
      const card = workProgress(view.plan, [], true);
      const done = window.approved!.done.size;
      const total = window.approved!.steps.length;
      if (done < total)
        check(
          card?.summary.startsWith(`Step ${done + 1}/${total}`) === true,
          "plan-parity",
          "phone work card shows the wrong step",
          `Step ${done + 1}/${total}`,
          card?.summary,
        );
    }
    for (const tool of window.tools) {
      for (const client of [phone, desktop]) {
        const shown = client.sessions.get(sessionId)?.tools.get(tool.toolCallId);
        check(
          shown !== undefined,
          "tool-parity",
          `${client.name} never got tool step ${tool.toolCallId}`,
          tool,
          shown,
        );
        check(
          shown!.title === tool.title,
          "tool-parity",
          `${client.name} tool title differs`,
          tool.title,
          shown!.title,
        );
        check(
          shown!.output.includes(tool.output),
          "tool-parity",
          `${client.name} tool output missing`,
          tool.output,
          shown!.output,
        );
        check(
          shown!.status === "completed",
          "tool-parity",
          `${client.name} tool step not completed`,
          "completed",
          shown!.status,
        );
      }
    }
  }, 10_000);
}

async function assertCloseOffered(label: string): Promise<void> {
  await assertCloseOfferedChecks(label);
  // A checkpoint that held: the state a later failure is diffed against.
  lastGood = snapshot();
}

async function assertCloseOfferedChecks(label: string): Promise<void> {
  step = `${label}: close offered`;
  await eventually(() => {
    const menu = phone.deskMenu();
    check(
      menu[0]?.kind === "close",
      "close-offered",
      "phone does not offer Close for a conversation open on the computer",
      { kind: "close" },
      menu,
    );
  }, 6_000);
}

async function assertOneAgentPerConversation(label: string): Promise<void> {
  await assertOneAgentPerConversationChecks(label);
  // A checkpoint that held: the state a later failure is diffed against.
  lastGood = snapshot();
}

async function assertOneAgentPerConversationChecks(label: string): Promise<void> {
  step = `${label}: one agent`;
  const counts = new Map<string, number[]>();
  for (const agent of liveAgents())
    for (const id of agent.sessions) counts.set(id, [...(counts.get(id) ?? []), agent.pid]);
  for (const [id, pids] of counts)
    check(
      pids.length <= 1,
      "one-agent",
      `conversation ${id} has ${pids.length} agent processes`,
      1,
      pids,
    );
  // The app window runs the conversation once it has it; an OG Coder window on
  // the same conversation at the same time would be a second writer.
  const appIds = new Set(app.windows.map((w) => w.agentSessionId).filter(Boolean));
  const openIterm = fakeIterm().filter((w) => w.open && /ogcoder|ggcoder/.test(w.command));
  for (const window of openIterm)
    for (const id of appIds)
      check(
        !window.command.includes(String(id)),
        "one-agent",
        `conversation ${id} is open in both the GG Coder app and OG Coder`,
        "one",
        window,
      );
}

async function assertNoLeaks(label: string, conversations: Set<string>): Promise<void> {
  await assertNoLeaksChecks(label, conversations);
  // A checkpoint that held: the state a later failure is diffed against.
  lastGood = snapshot();
}

async function assertNoLeaksChecks(label: string, conversations: Set<string>): Promise<void> {
  step = `${label}: no leaks`;
  await eventually(() => {
    check(
      app.windows.length === 0,
      "no-leaks",
      "GG Coder app windows left open",
      0,
      app.windows.map((w) => w.sessionId),
    );
    const open = fakeIterm().filter((w) => w.open);
    check(open.length === 0, "no-leaks", "iTerm windows left open", 0, open);
    check(
      (phone.desk?.windows ?? []).length === 0,
      "no-leaks",
      "daemon still announces windows",
      [],
      phone.desk?.windows,
    );
    // Nothing may still run this cycle's conversation (any of its ids).
    const holding = liveAgents().filter((a) => a.sessions.some((id) => conversations.has(id)));
    check(
      holding.length === 0,
      "no-leaks",
      "an agent still holds the closed conversation",
      0,
      holding,
    );
    // And agents do not pile up across cycles: at most the daemon's one warm spare.
    const all = liveAgents();
    check(all.length <= 1, "no-leaks", "agent processes accumulating", "<= 1 (a warm spare)", all);
  }, 12_000);
}

function assertMemory(): void {
  const kb = daemonRssKb();
  rssSamples.push({ cycle, kb });
  // Warm-up: the first cycles load code and caches.
  if (rssSamples.length < 6) return;
  const base = Math.min(...rssSamples.slice(2, 5).map((s) => s.kb));
  const recent = rssSamples.slice(-3).map((s) => s.kb);
  const floor = Math.min(...recent);
  // Climbing = even the lowest of the last three samples is well over the
  // early baseline (GC noise moves single samples, not the floor).
  check(
    floor < base * 1.6 + 30_000,
    "memory",
    `daemon RSS climbing: ${base}KB early, floor ${floor}KB now`,
    `< ${Math.round(base * 1.6 + 30_000)}KB`,
    rssSamples.slice(-10),
  );
}

// ---------------------------------------------------------------- one cycle

async function runCycle(): Promise<void> {
  cycle++;
  cyclePlan.length = 0;
  const nonce = `c${cycle}`;
  const record = (what: string) => {
    step = what;
    cyclePlan.push(`${stamp()} ${what}`);
    note(`cycle ${cycle}: ${what}`);
  };

  // 1. A new GG Coder chat on the phone, with a first turn by the stub agent.
  record("start a chat on the phone");
  const started = await phone.request(
    { t: "session.start", providerId: "ggcoder", cwd: PROJECT },
    "session.started",
  );
  const pewId: string = started.sessionId;
  const firstAgentId: string | undefined = started.agentSessionId;
  phone.current = pewId;
  record("first prompt (stub agent)");
  phone.send({ t: "session.prompt", sessionId: pewId, text: `hello ${nonce}` });
  await phone.waitFor(
    (m) => m.t === "session.idle" && m.sessionId === pewId,
    15_000,
    "first turn to end",
  );

  // 2. Open it in the GG Coder app: the daemon hands the conversation over.
  record("open in GG Coder app");
  const opened = await phone.request(
    { t: "desk.open", sessionId: pewId, target: "app" },
    "desk.opened",
  );
  check(opened.ok === true, "close-offered", "desk.open app failed", true, opened);
  await eventually(() =>
    check(
      phone.current !== pewId || app.windows.length > 0,
      "close-offered",
      "no app window",
      1,
      app.windows.length,
    ),
  );
  const sessionId = phone.current!;
  const window = await (async () => {
    let found: AppWindow | undefined;
    await eventually(() => {
      found = app.windows.find((w) => w.agentSessionId);
      check(found !== undefined, "close-offered", "app window not open", 1, app.windows.length);
    });
    return found!;
  })();
  await assertCloseOffered("after open in app");

  // 3. Three windows on one conversation: also pew2 chat, and OG Coder.
  record("open in pew2 chat too");
  const chat = await phone.request({ t: "desk.open", sessionId, target: "chat" }, "desk.opened");
  note("desk.open chat", chat);
  tally(`open pew2 chat -> ${chat.ok ? `ok (${chat.app ?? "?"})` : `refused: ${chat.message}`}`);
  record("open in OG Coder too (must not become a second writer)");
  const og = await phone.request({ t: "desk.open", sessionId, target: "native" }, "desk.opened");
  note("desk.open native", og);
  tally(
    `open OG Coder while in the app -> ${og.ok ? `ok (${og.app ?? "?"})` : `refused: ${og.message}`}`,
  );
  await assertOneAgentPerConversation("three windows");
  await assertCloseOffered("three windows");

  // 4. Plan mode: the app writes a plan and waits for a decision.
  record("enter plan mode (app writes a plan)");
  await app.runTurnFor(window, `PLAN:4:${nonce}`);
  await eventually(() => {
    const pending = phone.sessions.get(sessionId)?.pendingPlan;
    check(Boolean(pending), "plan-parity", "phone never got the pending plan", "pending", pending);
  });
  await assertCloseOffered("in plan mode");

  // 5. Accept from the phone: the app starts a fresh conversation (rotation).
  record("accept the plan from the phone (conversation id rotates)");
  const pending = phone.sessions.get(sessionId)!.pendingPlan!;
  const before = window.agentSessionId;
  phone.send({ t: "plan.decide", sessionId, generation: pending.generation, action: "accept" });
  await eventually(
    () =>
      check(
        window.agentSessionId !== before && !window.busy,
        "close-offered",
        "accept did not rotate the conversation",
        "new id",
        window.agentSessionId,
      ),
    10_000,
  );
  await assertCloseOffered("after accept (rotated)");

  // 6. Streamed tool steps and plan progress, while the phone drops and comes back.
  record("streamed tool steps (3) + steps 1-2 done");
  const turn = app.runTurnFor(window, `WORK:3:${nonce}a DONE:1-2`);
  await Bun.sleep(60);
  record("drop the phone mid-turn");
  phone.drop();
  await Bun.sleep(400);
  await turn;
  record("reconnect the phone (catch-up)");
  await phone.connect();
  await assertParity(sessionId, window, "after reconnect");
  await assertCloseOffered("after reconnect");

  // 7. Plan mode toggled while working, then compaction (a second rotation).
  record("exit plan mode via feedback round-trip");
  await app.runTurnFor(window, `PLAN:4:${nonce}b`);
  await eventually(() =>
    check(
      Boolean(phone.sessions.get(sessionId)?.pendingPlan),
      "plan-parity",
      "second plan not shown",
      "pending",
      null,
    ),
  );
  const second = phone.sessions.get(sessionId)!.pendingPlan!;
  phone.send({ t: "plan.decide", sessionId, generation: second.generation, action: "reject" });
  await eventually(() =>
    check(window.plan === null, "plan-parity", "reject did not clear the plan", null, window.plan),
  );
  record("compaction: conversation id rotates again");
  await app.compact(window);
  await Bun.sleep(300);
  record("more tool steps (2) + steps 3-4 done");
  await app.runTurnFor(window, `WORK:2:${nonce}b DONE:3-4`);
  await assertParity(sessionId, window, "after compaction");
  await assertCloseOffered("after compaction");
  await assertOneAgentPerConversation("after compaction");

  // 8. Close from the phone: every window on the computer goes. The daemon
  // (rightly) refuses Close mid-reply, so first the turn must settle to idle
  // on the phone, as the user sees it before tapping.
  record("wait for the phone to see the turn settle");
  await eventually(() => {
    const view = phone.sessions.get(sessionId);
    // An idle that came after the turn's last event: an earlier one (the plan
    // turn's) says nothing about this turn.
    check(
      // Same millisecond counts: the daemon sends the last event and the idle
      // in one tick.
      (view?.idleAt ?? 0) >= (view?.eventAt ?? 0) && view?.idleAt !== undefined,
      "settles",
      "the finished turn never reached the phone as idle",
      "session.idle after the last event",
      { idleAt: view?.idleAt ?? "never", lastEventAt: view?.eventAt },
    );
  }, 12_000);
  record("close from the phone");
  check(
    phone.deskMenu()[0]?.kind === "close",
    "close-offered",
    "Close not offered just before closing",
    "close",
    phone.deskMenu(),
  );
  // Every id this conversation had: the app window's rotations, and the agent
  // id pew2's own session ran it under before the handover.
  const conversations = new Set<string>(
    [...window.history, phone.sessions.get(sessionId)?.agentSessionId, firstAgentId].filter(
      (id): id is string => typeof id === "string",
    ),
  );
  const closed = await phone.request({ t: "desk.close", sessionId }, "desk.closed");
  check(closed.ok === true, "no-leaks", "desk.close failed", true, closed);
  await assertNoLeaks("after close", conversations);
  assertMemory();
  lastGood = snapshot();
}

// ---------------------------------------------------------------- failure dump

function dump(error: unknown): void {
  const failed = snapshot();
  const invariant = error instanceof InvariantError ? error.invariant : "harness";
  writeFileSync(
    path.join(OUT, "failure.json"),
    JSON.stringify(
      {
        run: RUN,
        cycle,
        step,
        invariant,
        message: error instanceof Error ? error.message : String(error),
        expected: error instanceof InvariantError ? error.expected : undefined,
        actual: error instanceof InvariantError ? error.actual : undefined,
        stack: error instanceof Error ? error.stack : undefined,
        cycleSteps: cyclePlan,
        rssSamples,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(OUT, "cycle.txt"),
    `cycle ${cycle}, failed at: ${step}\n\n${cyclePlan.join("\n")}\n`,
  );
  const cycleStart = events.findIndex(
    (e) => e.dir === "note" && JSON.stringify(e.frame).includes(`cycle ${cycle}:`),
  );
  writeFileSync(
    path.join(OUT, "events.jsonl"),
    events
      .slice(Math.max(0, cycleStart - 50))
      .map((e) => JSON.stringify({ ...e, t: new Date(e.at).toISOString() }))
      .join("\n"),
  );
  writeFileSync(path.join(OUT, "state-at-failure.json"), JSON.stringify(failed, null, 2));
  writeFileSync(path.join(OUT, "state-last-good.json"), JSON.stringify(lastGood ?? null, null, 2));
  writeFileSync(path.join(OUT, "state-diff.txt"), diff(lastGood ?? {}, failed).join("\n"));
  writeFileSync(path.join(OUT, "daemon.log"), daemonOut.join("\n"));
  writeFileSync(path.join(OUT, "app-calls.json"), JSON.stringify(app.calls, null, 2));
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  say(`run ${RUN}: ${minutes} min${quick ? " (--quick)" : ""}, out ${path.relative(REPO, OUT)}`);
  const { token } = prepareIsolation();
  // The daemon derives the pairing from PEW2_TOKEN: clients present the
  // derived room id as their token and seal with the derived key.
  const pairing = pairingFromToken(token);
  const { key } = pairing;
  const port = await freePort();
  app = await startFakeApp({ home: HOME });
  say(`fake GG Coder app on :${app.port}, isolated daemon on :${port} (HOME=${HOME})`);
  await startDaemon(port, token);
  const rssStart = daemonRssKb();
  say(`daemon up (pid ${daemon?.pid}, ${Math.round(rssStart / 1024)}MB)`);

  phone = new SoakClient("phone", {
    port,
    token: pairing.token,
    key,
    deviceId: `soak-phone-${process.pid}`,
    log,
  });
  desktop = new SoakClient("desktop", {
    port,
    token: pairing.token,
    key,
    deviceId: `pew2-cli@soak#chat-${process.pid}`,
    log,
  });
  await phone.connect();
  await desktop.connect();
  await eventually(
    () =>
      check(
        (phone.desk?.app ?? []).includes("ggcoder"),
        "close-offered",
        "daemon never found the fake GG Coder app",
        ["ggcoder"],
        phone.desk,
      ),
    15_000,
  );
  say("phone + desktop connected; daemon sees the GG Coder app");

  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const started = Date.now();
    await runCycle();
    cycleTimes.push(Date.now() - started);
    say(
      `cycle ${String(cycle).padStart(3)} ok  ${((Date.now() - started) / 1000).toFixed(1)}s  rss ${Math.round(daemonRssKb() / 1024)}MB  agents ${liveAgents().length}  checks: close, plan, tools, one-agent, leaks, memory, settles`,
    );
  }
  say(`PASS: ${cycle} cycles in ${minutes} min, every invariant held after every cycle`);
  for (const line of INVARIANTS) say(`  held  ${line}`);
  const rssEnd = daemonRssKb();
  say(`rss: ${Math.round(rssStart / 1024)}MB at start -> ${Math.round(rssEnd / 1024)}MB at end`);
  for (const [outcome, count] of outcomes) say(`  ${String(count).padStart(4)}x ${outcome}`);
  writeFileSync(
    path.join(OUT, "summary.json"),
    JSON.stringify(
      {
        run: RUN,
        result: "pass",
        minutes,
        cycles: cycle,
        invariants: INVARIANTS,
        cycleMs: cycleTimes,
        rssKb: rssSamples,
        rssStartKb: rssStart,
        rssEndKb: rssEnd,
        outcomes: Object.fromEntries(outcomes),
        appCalls: app.calls.length,
      },
      null,
      2,
    ),
  );
  say(`summary: .gg/soak/${RUN}/summary.json`);
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  say(`FAIL in cycle ${cycle} at "${step}"`);
  say(`  ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof InvariantError) {
    say(`  expected: ${JSON.stringify(error.expected)?.slice(0, 300)}`);
    say(`  actual:   ${JSON.stringify(error.actual)?.slice(0, 300)}`);
  }
  try {
    dump(error);
    say(`  dumped cycle, event log and state diff to ${path.relative(REPO, OUT)}/`);
  } catch (dumpError) {
    say(`  could not write the dump: ${String(dumpError)}`);
  }
  code = 1;
} finally {
  phone?.close();
  desktop?.close();
  daemon?.kill("SIGTERM");
  await Bun.sleep(500);
  if (daemon && daemon.exitCode === null) daemon.kill("SIGKILL");
  app?.stop();
  for (const agent of liveAgents()) {
    try {
      process.kill(agent.pid, "SIGTERM");
    } catch {
      // Gone.
    }
  }
  if (code === 0) rmSync(ROOT, { recursive: true, force: true });
  else say(`  isolated state kept at ${ROOT}`);
}
process.exit(code);
