import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { APP_CONFIG_REFUSAL, DESK_DRAFT_FROM, Daemon } from "./index.js";
import { handleMessage } from "./handler.js";
import { SessionLog } from "./session/log.js";
import { startFakeApp, type FakeApp } from "./testing/fake-gg-app.js";

const AGENT_ID = "12345678-aaaa-bbbb-cccc-123456789abc";
const CWD = "/Users/test/my project";
const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const msg = (id: string, role: string, content: unknown, parentId: string | null = null) =>
  line({ type: "message", id, parentId, message: { role, content } });

async function until<T>(read: () => T | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = read();
    if (value) return value;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A daemon with one ACP ggcoder session, the fake app found, and no iTerm at all. */
async function appRig(options: { withApp?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pew2-app-"));
  const directory = path.join(root, "Users_test_my project");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `2026-10-13T10-00-00-000Z_${AGENT_ID.slice(0, 8)}.jsonl`);
  await writeFile(
    file,
    line({ type: "session", id: AGENT_ID, conversationId: AGENT_ID, cwd: CWD }) +
      msg("u0", "user", "Earlier question") +
      msg("a0", "assistant", [{ type: "text", text: "Earlier answer" }], "u0"),
  );
  const app: FakeApp = await startFakeApp();
  const scripts: string[] = [];
  const daemon = new Daemon({ id: "t", name: "t" }, false, process.env, {
    platform: "darwin",
    hasITerm: () => true,
    osa: async (script) => {
      scripts.push(script);
      return { code: 0, stdout: "ok", stderr: "", timedOut: false };
    },
    sessionsRoot: root,
    pollMs: 20,
    alivePollMs: 20,
    throttleMs: 10,
    turnGraceMs: 60,
    appDesk: { file: options.withApp === false ? path.join(root, "none.json") : app.file },
  });
  const sent: any[] = [];
  daemon.attach((message) => sent.push(message));
  (daemon as any).providers = [
    {
      manifest: { id: "ggcoder", name: "OG Coder", pew: { transport: "acp" } },
      command: "ogcoder",
      args: ["acp"],
      commandMissing: false,
      missingEnv: [],
    },
  ];
  await daemon.appDesk.check();
  let closed = 0;
  const session = {
    handle: { close: () => void closed++ },
    log: new SessionLog("ggcoder-old"),
    providerId: "ggcoder",
    agentSessionId: AGENT_ID,
    cwd: CWD,
    live: true,
    lastUsedAt: Date.now(),
    ready: Promise.resolve(),
    working: false as boolean,
    permissions: new Map<string, unknown>(),
  };
  (daemon as any).sessions.set("ggcoder-old", session);
  const replies: any[] = [];
  const send = (message: unknown) =>
    handleMessage(JSON.stringify(message), {
      daemon,
      reply: (m: unknown) => replies.push(m),
      broadcast: (m: unknown) => sent.push(m),
    });
  const done = () => {
    daemon.closeAll();
    app.stop();
  };
  return {
    daemon,
    app,
    sent,
    replies,
    scripts,
    send,
    file,
    directory,
    done,
    closedCount: () => closed,
  };
}

const desk = (sent: any[]) => sent.findLast((m) => m.t === "providers")?.desk;

test("the announcement lists the app's providers only while the app is there", async () => {
  const rig = await appRig();
  (rig.daemon as any).announceProviders();
  expect(desk(rig.sent)).toEqual({
    available: true,
    capture: true,
    native: ["ggcoder"],
    app: ["ggcoder"],
  });
  rig.done();
  const none = await appRig({ withApp: false });
  (none.daemon as any).announceProviders();
  expect(desk(none.sent).app).toBeUndefined();
  // Refused in words when asked anyway (an older phone, a stale announcement).
  await none.send({ t: "desk.open", requestId: "r", sessionId: "ggcoder-old", target: "app" });
  expect(none.replies[0]).toMatchObject({ ok: false });
  expect(none.replies[0].message).toContain("GG Coder app");
  none.done();
});

test("handover to the app: opened by conversation, typed both ways, mirrored, closed from the phone", async () => {
  const rig = await appRig();
  const { daemon, app, sent, replies, send, file } = rig;
  await send({ t: "desk.open", requestId: "r1", sessionId: "ggcoder-old", target: "app" });
  expect(replies[0]).toEqual({ t: "desk.opened", requestId: "r1", ok: true, app: "GG Coder app" });
  expect(app.calls.find((c) => c.route === "open")?.body).toEqual({
    cwd: CWD,
    agentSessionId: AGENT_ID,
    sessionPath: file,
    mode: "code",
  });
  // pew2's own agent let go, and no iTerm was touched.
  expect(rig.closedCount()).toBe(1);
  expect(rig.scripts).toEqual([]);
  const started = sent.find((m) => m.t === "session.started");
  expect(started).toMatchObject({ resumed: true, agentSessionId: AGENT_ID, cwd: CWD });
  const id: string = started.sessionId;
  expect(id).not.toBe("ggcoder-old");
  expect(daemon.isNative(id)).toBe(true);
  expect(daemon.forwardedSession("ggcoder-old")).toBe(id);
  (daemon as any).announceProviders();
  expect(desk(sent).windows).toEqual([{ agentSessionId: AGENT_ID, kind: "native", app: true }]);

  // Phone draft: latest text into the window's composer.
  await send({ t: "session.draft", sessionId: id, text: "hel" });
  await send({ t: "session.draft", sessionId: id, text: "hello" });
  await until(() => app.windows[0]?.composer === "hello", "draft in the app");

  // Typed at the desk: the phone's composer follows.
  app.emit({ type: "draft", sessionId: "win-1", text: "from the Mac" });
  await until(
    () => sent.find((m) => m.t === "session.draft" && m.from === DESK_DRAFT_FROM),
    "desk draft",
  );
  expect(sent.findLast((m) => m.t === "session.draft")).toMatchObject({
    sessionId: id,
    text: "from the Mac",
  });

  // Prompt: echoed, sent whole, the reply read back from the file.
  await send({ t: "session.prompt", sessionId: id, text: "do it\nnow" });
  await until(() => app.calls.some((c) => c.route === "send"), "send");
  expect(app.calls.find((c) => c.route === "send")?.body).toEqual({
    sessionId: "win-1",
    text: "do it\nnow",
  });
  await appendFile(
    file,
    msg("u1", "user", "do it\nnow") +
      msg("a1", "assistant", [{ type: "text", text: "Done it" }], "u1"),
  );
  await until(
    () => JSON.stringify(sent.filter((m) => m.t === "session.event")).includes("Done it"),
    "reply mirrored",
  );
  // The app's pills are its own.
  await expect(daemon.setConfigOption(id, "model", "x")).rejects.toThrow(APP_CONFIG_REFUSAL);
  // Stop is the window's stop button.
  await send({ t: "session.cancel", sessionId: id });
  await until(() => app.calls.some((c) => c.route === "abort"), "abort");

  // Close from the phone: refused mid-reply, otherwise the window closes and the mirror goes.
  const mirror = (daemon as any).sessions.get(id);
  mirror.working = true;
  await send({ t: "desk.close", requestId: "c1", agentSessionId: AGENT_ID });
  expect(replies.at(-1)).toMatchObject({ ok: false });
  expect(replies.at(-1).message).toContain("GG Coder app is in the middle of a reply");
  mirror.working = false;
  await send({ t: "desk.close", requestId: "c2", agentSessionId: AGENT_ID });
  expect(replies.at(-1)).toEqual({ t: "desk.closed", requestId: "c2", ok: true });
  expect(app.windows).toEqual([]);
  expect(daemon.isNative(id)).toBe(false);
  expect(desk(sent).windows).toBeUndefined();
  rig.done();
});

test("a window closed in the app ends the mirror, and so does the app quitting", async () => {
  const rig = await appRig();
  const { daemon, app, sent, send } = rig;
  await send({ t: "desk.open", requestId: "r1", sessionId: "ggcoder-old", target: "app" });
  const id = sent.find((m) => m.t === "session.started").sessionId;
  // Closed by hand: the `closed` event.
  app.windows = [];
  app.emit({ type: "closed", sessionId: "win-1" });
  await until(() => !daemon.isNative(id), "closed by event");
  expect(sent.findLast((m) => m.t === "providers").activeSessions).not.toContain(id);

  // Opened again, then the app quits (file gone, stream dropped).
  (daemon as any).sessions.set("ggcoder-old2", {
    handle: { close: () => {} },
    log: new SessionLog("ggcoder-old2"),
    providerId: "ggcoder",
    agentSessionId: AGENT_ID,
    cwd: CWD,
    live: true,
    lastUsedAt: Date.now(),
    ready: Promise.resolve(),
    permissions: new Map(),
  });
  await send({ t: "desk.open", requestId: "r2", sessionId: "ggcoder-old2", target: "app" });
  const second = sent.findLast((m) => m.t === "session.started").sessionId;
  expect(daemon.isNative(second)).toBe(true);
  const { rm } = await import("node:fs/promises");
  await rm(app.file);
  app.dropStreams();
  await until(() => !daemon.isNative(second), "ended with the app");
  expect(desk(sent).app).toBeUndefined();
  rig.done();
});

test("a window gone from the app's list (missed event) ends the mirror too", async () => {
  const rig = await appRig();
  const { daemon, app, sent, send } = rig;
  await send({ t: "desk.open", requestId: "r1", sessionId: "ggcoder-old", target: "app" });
  const id = sent.find((m) => m.t === "session.started").sessionId;
  app.windows = [];
  await until(() => !daemon.isNative(id), "closed by the poll");
  rig.done();
});

test("a new conversation opens a fresh app window and links the conversation it names", async () => {
  const rig = await appRig();
  const { daemon, app, sent, directory } = rig;
  (daemon as any).knownProject = async (_p: string, cwd: string) => cwd;
  (daemon as any).probes.set("ggcoder", Promise.resolve({ configOptions: [], sessions: [] }));
  const NEW_ID = "new-conversation-id";
  // The app names the conversation only after its first prompt, in its window list.
  setTimeout(() => {
    void writeFile(
      path.join(directory, "2026-10-13T20-00-00-000Z_newconv.jsonl"),
      line({ type: "session", id: NEW_ID, cwd: CWD, timestamp: new Date().toISOString() }),
    );
    const window = app.windows[0];
    if (window) window.agentSessionId = NEW_ID;
  }, 40);
  const replies: any[] = [];
  await handleMessage(
    JSON.stringify({
      t: "desk.open",
      requestId: "n1",
      target: "app",
      providerId: "ggcoder",
      cwd: CWD,
    }),
    { daemon, reply: (m: unknown) => replies.push(m), broadcast: (m: unknown) => sent.push(m) },
  );
  expect(replies.at(-1)).toMatchObject({ t: "desk.opened", ok: true, app: "GG Coder app" });
  expect(app.calls.find((c) => c.route === "open")?.body).toEqual({ cwd: CWD, mode: "code" });
  const started = sent.findLast((m) => m.t === "session.started");
  expect(started.resumed).toBeUndefined();
  expect(started.agentSessionId).toBe(NEW_ID);
  expect(daemon.isNative(started.sessionId)).toBe(true);
  rig.done();
});

test("the iTerm target is untouched: native still opens iTerm, not the app", async () => {
  const rig = await appRig();
  const { app, send, replies } = rig;
  rig.scripts.length = 0;
  // The fake osa gives no session id, so the iTerm open fails, but it is iTerm that was asked.
  await send({ t: "desk.open", requestId: "r1", sessionId: "ggcoder-old", target: "native" });
  expect(rig.scripts.some((s) => s.includes("create window"))).toBe(true);
  expect(app.calls.some((c) => c.route === "open")).toBe(false);
  void replies;
  rig.done();
});

test("a new app chat the app names at once can send (29 Oct: mirror.expectEcho undefined)", async () => {
  const rig = await appRig();
  const { daemon, app, sent, directory } = rig;
  (daemon as any).knownProject = async (_p: string, cwd: string) => cwd;
  (daemon as any).probes.set("ggcoder", Promise.resolve({ configOptions: [], sessions: [] }));
  const NEW_ID = "named-at-once";
  // The real desktop app answers /phone/open with the fresh conversation's id
  // and file straight away.
  await writeFile(
    path.join(directory, "2026-10-29T10-00-00-000Z_namedonce.jsonl"),
    line({ type: "session", id: NEW_ID, cwd: CWD, timestamp: new Date().toISOString() }),
  );
  app.freshAgentSessionId = NEW_ID;
  const replies: any[] = [];
  const ctx = {
    daemon,
    reply: (m: unknown) => replies.push(m),
    broadcast: (m: unknown) => sent.push(m),
  };
  await handleMessage(
    JSON.stringify({
      t: "desk.open",
      requestId: "n2",
      target: "app",
      providerId: "ggcoder",
      cwd: CWD,
    }),
    ctx,
  );
  expect(replies.at(-1)).toMatchObject({ t: "desk.opened", ok: true });
  const started = sent.findLast((m) => m.t === "session.started");
  expect(started.agentSessionId).toBe(NEW_ID);
  await handleMessage(
    JSON.stringify({ t: "session.prompt", sessionId: started.sessionId, text: "Hi how are you" }),
    ctx,
  );
  await until(() => app.calls.some((c) => c.route === "send"), "sent to the app");
  expect(app.calls.find((c) => c.route === "send")?.body).toMatchObject({
    text: "Hi how are you",
  });
  expect(sent.some((m) => m.t === "session.error" || /expectEcho/.test(JSON.stringify(m)))).toBe(
    false,
  );
  rig.done();
});

const PLAN = { planPath: "/p/.gg/plans/x.md", content: "# Plan\n- do it", generation: 3 };

async function openedApp() {
  const rig = await appRig();
  await rig.send({ t: "desk.open", requestId: "r1", sessionId: "ggcoder-old", target: "app" });
  const id: string = rig.sent.find((m) => m.t === "session.started").sessionId;
  return { ...rig, id };
}

test("an app window's plan reaches the phone as plan.state, by event and by the window list", async () => {
  const rig = await openedApp();
  const { app, sent, id, daemon } = rig;
  rig.app.emit({ type: "plan", sessionId: "win-1", plan: PLAN });
  const state = await until(
    () => sent.findLast((m) => m.t === "plan.state" && m.pending),
    "plan.state",
  );
  expect(state).toEqual({ t: "plan.state", sessionId: id, planMode: true, pending: PLAN });
  expect(daemon.catchUp({ [id]: -1 }).find((f) => f.sessionId === id)?.plan).toEqual(state);
  // The poll alone (a missed event) clears it.
  const window = app.windows[0]!;
  window.plan = null;
  window.planMode = false;
  await until(
    () => sent.findLast((m) => m.t === "plan.state")?.pending === null,
    "cleared by poll",
  );
  rig.done();
});

test("plan.decide on an app window drives /phone/plan; 409 answers an error and clears the sheet", async () => {
  const rig = await openedApp();
  const { app, sent, replies, send, id } = rig;
  for (const [action, feedback] of [
    ["feedback", "shorter"],
    ["reject", undefined],
    ["accept", undefined],
  ] as const) {
    app.windows[0]!.plan = PLAN;
    await send({ t: "plan.decide", sessionId: id, generation: 3, action, feedback });
    expect(app.calls.findLast((c) => c.route === "plan")?.body).toEqual({
      sessionId: "win-1",
      decision: action,
      generation: 3,
      ...(feedback && { feedback }),
    });
  }
  expect(replies.filter((m) => m.t === "error")).toEqual([]);
  // Nothing waiting now.
  await send({ t: "plan.decide", sessionId: id, generation: 3, action: "accept" });
  expect(replies.at(-1)).toMatchObject({ t: "error", sessionId: id });
  app.windows[0]!.plan = PLAN;
  await send({ t: "plan.decide", sessionId: id, generation: 2, action: "accept" });
  expect(replies.at(-1).message).toContain("changed");
  expect(sent.findLast((m) => m.t === "plan.state")?.pending).toBeNull();
  rig.done();
});

test("an accept that starts a fresh conversation keeps the phone on the same session", async () => {
  const rig = await openedApp();
  const { app, sent, send, id, daemon, directory } = rig;
  const NEXT = "after-accept-id";
  const next = path.join(directory, "2026-10-29T12-00-00-000Z_afteracc.jsonl");
  await writeFile(next, line({ type: "session", id: NEXT, cwd: CWD }) + msg("p0", "user", "old"));
  app.acceptAgentSessionId = NEXT;
  app.windows[0]!.plan = PLAN;
  await send({ t: "plan.decide", sessionId: id, generation: 3, action: "accept" });
  const session = (daemon as any).sessions.get(id);
  await until(() => session.agentSessionId === NEXT, "re-pointed");
  expect(daemon.isNative(id)).toBe(true);
  await appendFile(
    next,
    msg("u1", "user", "implement") +
      msg("a1", "assistant", [{ type: "text", text: "Implementing now" }], "u1"),
  );
  await until(
    () =>
      sent.some(
        (m) =>
          m.t === "session.event" &&
          m.sessionId === id &&
          JSON.stringify(m).includes("Implementing"),
      ),
    "new conversation mirrored into the same session",
  );
  // The baseline: what the new file held before is not repeated.
  expect(JSON.stringify(sent.filter((m) => m.t === "session.event"))).not.toContain('"old"');
  rig.done();
});

test("a window that changes conversation by itself (windows event) is followed too", async () => {
  const rig = await openedApp();
  const { app, id, daemon, directory } = rig;
  await writeFile(
    path.join(directory, "2026-10-29T13-00-00-000Z_byitself.jsonl"),
    line({ type: "session", id: "by-itself", cwd: CWD }),
  );
  app.windows[0]!.agentSessionId = "by-itself";
  app.emit({ type: "windows" });
  await until(() => (daemon as any).sessions.get(id)?.agentSessionId === "by-itself", "followed");
  rig.done();
});

const ASK = {
  id: "ask-1",
  questions: [
    {
      id: "next",
      question: "What should I do next?",
      kind: "choice",
      detail: "Pick one",
      allowOther: false,
      extra: "dropped",
      options: [
        { label: "Run tests", value: "tests", hint: "all of them", recommended: true },
        { label: "Ship it" },
        { nolabel: true },
      ],
    },
    { id: "bad", question: "no kind" },
  ],
};
const ASK_WIRE = [
  {
    id: "next",
    question: "What should I do next?",
    kind: "choice" as const,
    detail: "Pick one",
    allowOther: false,
    options: [
      { label: "Run tests", value: "tests", hint: "all of them", recommended: true },
      { label: "Ship it" },
    ],
  },
];

test("an app window's question reaches the phone as ask_user, in catch-up, by event and by poll", async () => {
  const rig = await openedApp();
  const { app, sent, id, daemon } = rig;
  app.emit({ type: "ask", sessionId: "win-1", ask: ASK });
  await until(() => (daemon as any).sessions.get(id).asks?.has("ask-1"), "ask held");
  expect(daemon.catchUp({ [id]: -1 }).find((f) => f.sessionId === id)?.asks).toEqual([
    { requestId: "ask-1", questions: ASK_WIRE },
  ]);
  expect(JSON.stringify(sent)).toContain('"kind":"ask_user"');
  // Answered at the desk.
  app.emit({ type: "ask_closed", sessionId: "win-1", ids: ["ask-1"] });
  await until(() => JSON.stringify(sent).includes("ask_user_closed"), "closed by event");
  // The poll alone opens and closes one too.
  app.windows[0]!.asks = [{ ...ASK, id: "ask-2" }];
  await until(() => (daemon as any).sessions.get(id).asks?.has("ask-2"), "opened by poll");
  app.windows[0]!.asks = [];
  await until(() => (daemon as any).sessions.get(id).asks?.size === 0, "closed by poll");
  rig.done();
});

test("session.ask on an app window drives /phone/ask; 409 closes the card with an error", async () => {
  const rig = await openedApp();
  const { app, replies, send, id, daemon } = rig;
  app.windows[0]!.asks = [ASK];
  await until(() => (daemon as any).sessions.get(id).asks?.has("ask-1"), "ask held");
  const result = { action: "answer", answers: { next: "tests" } };
  await send({ t: "session.ask", sessionId: id, requestId: "ask-1", result });
  expect(app.calls.findLast((c) => c.route === "ask")?.body).toEqual({
    sessionId: "win-1",
    id: "ask-1",
    action: "answer",
    answers: { next: "tests" },
  });
  expect((daemon as any).sessions.get(id).asks.size).toBe(0);
  expect(replies.filter((m) => m.t === "error")).toEqual([]);
  // Settled in the window first: the phone's card still closes, with a word why.
  (daemon as any).sessions.get(id).asks.set("ask-9", ASK_WIRE);
  await send({ t: "session.ask", sessionId: id, requestId: "ask-9", result: { action: "cancel" } });
  expect(app.calls.findLast((c) => c.route === "ask")?.body).toEqual({
    sessionId: "win-1",
    id: "ask-9",
    action: "cancel",
  });
  expect(replies.at(-1)).toMatchObject({ t: "error", code: "ask", sessionId: id });
  expect((daemon as any).sessions.get(id).asks.size).toBe(0);
  rig.done();
});

test("session.ask on a pew2 session still goes to its own agent, not the app", async () => {
  const rig = await appRig();
  const { app, send, daemon } = rig;
  const answers: unknown[] = [];
  const session = (daemon as any).sessions.get("ggcoder-old");
  session.handle.answerAsk = (requestId: string, result: unknown) => {
    answers.push([requestId, result]);
    return true;
  };
  session.asks = new Map([["q1", []]]);
  await send({
    t: "session.ask",
    sessionId: "ggcoder-old",
    requestId: "q1",
    result: { action: "cancel" },
  });
  expect(answers).toEqual([["q1", { action: "cancel" }]]);
  expect(session.asks.size).toBe(0);
  expect(app.calls.some((c) => c.route === "ask")).toBe(false);
  rig.done();
});
