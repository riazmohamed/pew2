import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GgCoderMirror } from "./acp/ggcoder-mirror.js";
import { DESK_DRAFT_FROM, Daemon, NATIVE_CONFIG_REFUSAL } from "./index.js";
import { handleMessage } from "./handler.js";
import { SessionLog } from "./session/log.js";
import type { OsaResult } from "./native-desk.js";

const AGENT_ID = "12345678-aaaa-bbbb-cccc-123456789abc";
const CWD = "/Users/test/my project";

const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const msg = (id: string, role: string, content: unknown, parentId: string | null = null) =>
  line({ type: "message", id, parentId, message: { role, content } });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pew2-native-"));
  const directory = path.join(root, "Users_test_my project");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `2026-10-13T10-00-00-000Z_${AGENT_ID.slice(0, 8)}.jsonl`);
  await writeFile(
    file,
    line({ type: "session", id: AGENT_ID, conversationId: AGENT_ID, cwd: CWD }) +
      msg("u0", "user", "Earlier question") +
      msg("a0", "assistant", [{ type: "text", text: "Earlier answer" }], "u0"),
  );
  return { root, file };
}

async function until<T>(read: () => T | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = read();
    if (value) return value;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("the mirror emits only what is appended after the baseline, as history renders it", async () => {
  const { root, file } = await fixture();
  const events: unknown[] = [];
  const mirror = new GgCoderMirror({
    agentSessionId: AGENT_ID,
    cwd: CWD,
    sessionsRoot: root,
    pollMs: 20,
    callbacks: {
      onUpdate: (update) => events.push(update),
      onUserMessage: (text) => events.push({ user: text }),
      onTurnStart: () => events.push("start"),
      onTurnEnd: () => events.push("end"),
    },
  });
  await mirror.baseline();
  mirror.start();
  mirror.expectEcho("from the phone");
  await appendFile(
    file,
    line({ type: "custom", kind: "run_started", id: "r1" }) +
      msg("u1", "user", "typed at the Mac") +
      msg("a1", "assistant", [{ type: "text", text: "Looking" }, { type: "tool_call", id: "t1", name: "ls", args: { path: "." } }], "u1") +
      msg("tr1", "tool", [{ type: "tool_result", toolCallId: "t1", content: "a b" }], "a1") +
      msg("a2", "assistant", [{ type: "text", text: "Done" }], "tr1") +
      // Half a line: not read until it is finished.
      '{"type":"custom","kind":"run_fin',
  );
  await until(() => events.length >= 6, "the turn");
  await appendFile(file, 'ished","id":"r2"}\n' + msg("u2", "user", "from the phone with /tmp/x.png"));
  await until(() => events.includes("end"), "the turn end");
  await Bun.sleep(60);
  mirror.stop();
  expect(events).toEqual([
    "start",
    { user: "typed at the Mac" },
    "start",
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking" } },
    { sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", status: "in_progress", rawInput: { path: "." } },
    { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } },
    "end",
    // The phone's own prompt is recognised, not shown twice.
    "start",
  ]);
  // Nothing from before the handover ("Earlier ...") came through.
  expect(JSON.stringify(events)).not.toContain("Earlier");
});

/** A Daemon with one planted, idle ggcoder session and fake iTerm. */
async function handoverRig(options: { alive?: () => boolean } = {}) {
  const { root, file } = await fixture();
  const scripts: string[] = [];
  // A fake OG Coder screen: keystrokes written in move its input and status
  // line the way the real one does, and a read returns its text.
  const desk = { input: "", model: "Opus", thinking: "high", plan: false };
  const cycle = ["low", "medium", "high", "xhigh", "max", "off"];
  const typeInto = (script: string) => {
    for (const [, raw] of script.matchAll(/write text (.+) newline NO/g)) {
      const text = raw!.replace(/\(character id (\d+)\)/g, (_, code) => String.fromCharCode(Number(code)))
        .split(" & ").map((part) => part.replace(/^"|"$/g, "").replace(/\\"/g, '"')).join("");
      if (text === "\u0015") desk.input = "";
      else if (text === "\u007f") desk.input = desk.input.slice(0, -1);
      else if (text === "\u001b[Z") desk.thinking = cycle[(cycle.indexOf(desk.thinking) + 1) % cycle.length]!;
      else if (text === "\r") {
        const model = /^\/model (\S+)$/.exec(desk.input);
        if (model) desk.model = model[1]![0]!.toUpperCase() + model[1]!.slice(1);
        desk.input = "";
      } else if (text !== "\u0005" && text !== "\u001b") desk.input += text;
    }
  };
  const screenText = () =>
    [
      " transcript",
      "▄".repeat(40),
      ` > ${desk.input || "  Type your message or / to run a command"}`,
      "▀".repeat(40),
      " Paddle_ken │ ⎇ main",
      ` ▏░░ 1% │ ${desk.model} │ Plan ${desk.plan ? "on" : "off"} │ Thinking ${desk.thinking} `,
    ].join("\n");
  const osa = async (script: string): Promise<OsaResult> => {
    scripts.push(script);
    if (script.includes("contents of aSession")) return { code: 0, stdout: screenText(), stderr: "", timedOut: false };
    if (script.includes("write text")) typeInto(script);
    if (script.includes("create window")) return { code: 0, stdout: "ITERM-1\n", stderr: "", timedOut: false };
    if (script.includes("return tty")) {
      return { code: 0, stdout: (options.alive?.() ?? true) ? "/dev/ttys009" : "gone", stderr: "", timedOut: false };
    }
    return { code: 0, stdout: "ok", stderr: "", timedOut: false };
  };
  const daemon = new Daemon({ id: "t", name: "t" }, false, process.env, {
    platform: "darwin",
    hasITerm: () => true,
    osa,
    ttyCommands: async () => ["-zsh", "node"],
    sessionsRoot: root,
    pollMs: 20,
    alivePollMs: 20,
    throttleMs: 10,
    readPollMs: 15,
    readQuietMs: 40,
    settleMs: 5,
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
  const ctx = { daemon, reply: (m: unknown) => replies.push(m), broadcast: (m: unknown) => sent.push(m) };
  const send = (message: unknown) => handleMessage(JSON.stringify(message), ctx);
  return { daemon, sent, replies, scripts, session, send, file, desk, closedCount: () => closed };
}

test("the announcement names ggcoder as native", async () => {
  const { daemon, sent } = await handoverRig();
  (daemon as any).announceProviders();
  expect(sent.findLast((m) => m.t === "providers").desk).toEqual({ available: true, native: ["ggcoder"] });
  daemon.closeAll();
});

test("a busy session is refused in words, and nothing is opened", async () => {
  const { daemon, replies, scripts, session, send } = await handoverRig();
  session.working = true;
  await send({ t: "desk.open", requestId: "r1", sessionId: "ggcoder-old", target: "native" });
  expect(replies[0]).toMatchObject({ t: "desk.opened", ok: false });
  expect(replies[0].message).toContain("middle of a reply");
  session.working = false;
  session.permissions.set("p1", {});
  await send({ t: "desk.open", requestId: "r2", sessionId: "ggcoder-old", target: "native" });
  expect(replies[1].message).toContain("approval");
  expect(scripts).toEqual([]);
  daemon.closeAll();
});

test("handover, routing and teardown", async () => {
  let alive = true;
  const rig = await handoverRig({ alive: () => alive });
  const { daemon, sent, replies, scripts, send, file, desk } = rig;
  await send({ t: "desk.open", requestId: "r1", sessionId: "ggcoder-old", target: "native" });
  expect(replies[0]).toEqual({ t: "desk.opened", requestId: "r1", ok: true, app: "iTerm" });

  // The iTerm window runs the real CLI, resumed, in the project.
  expect(scripts[0]).toContain("cd '\\\\''/Users/test/my project'\\\\'' && exec ogcoder --resume " + AGENT_ID);
  expect(scripts[0]).toContain("OG Coder · my project");
  // pew2's own agent let go.
  expect(rig.closedCount()).toBe(1);

  const started = sent.find((m) => m.t === "session.started");
  expect(started).toMatchObject({ providerId: "ggcoder", resumed: true, cwd: CWD, agentSessionId: AGENT_ID });
  const id: string = started.sessionId;
  expect(id).toMatch(/^ggcoder-[0-9a-z]+$/);
  expect(id).not.toBe("ggcoder-old");
  expect(sent.findLast((m) => m.t === "providers").activeSessions).toEqual([id]);
  // The transcript is painted from the file, as a resume is.
  const replay = sent.filter((m) => m.t === "session.replay" && m.sessionId === id).flatMap((m) => m.events);
  expect(JSON.stringify(replay)).toContain("Earlier answer");
  expect(sent.some((m) => m.t === "session.replay" && m.sessionId === id && m.complete === true)).toBe(true);

  // Draft: clear + text, no Enter, throttled; still mirrored to other clients.
  const before = scripts.length;
  await send({ t: "session.draft", sessionId: id, text: "hel" });
  await send({ t: "session.draft", sessionId: id, text: "hello" });
  await until(() => scripts.slice(before).some((s) => s.includes("write text")), "draft typed");
  await Bun.sleep(30);
  const drafts = scripts.slice(before).filter((s) => s.includes("write text"));
  expect(drafts).toHaveLength(1);
  // Key by key: a multi-character write would read as a paste in OG Coder.
  for (const ch of "hello") expect(drafts[0]).toContain(`write text "${ch}" newline NO`);
  expect(drafts[0]).not.toContain("character id 13");
  expect(sent.filter((m) => m.t === "session.draft" && m.sessionId === id).map((m) => m.text)).toEqual(["hel", "hello"]);

  // Prompt: echoed, typed, Enter. No immediate idle: the file ends the turn.
  await send({ t: "session.prompt", sessionId: id, text: "do it" });
  await until(() => scripts.some((s) => s.includes('"do it" newline NO') && s.includes("character id 13")), "prompt typed");
  expect(sent.some((m) => m.t === "session.event" && m.payload?.kind === "user_message" && m.payload.text === "do it")).toBe(true);
  expect(daemon.sessionView(id)?.working).toBe(true);
  expect(sent.some((m) => m.t === "session.idle")).toBe(false);

  // OG Coder writes the turn; the phone sees it and goes idle at the end.
  await appendFile(
    file,
    line({ type: "custom", kind: "run_started", id: "r1" }) +
      msg("u1", "user", "do it") +
      msg("a1", "assistant", [{ type: "text", text: "Did it" }], "u1") +
      line({ type: "custom", kind: "run_finished", id: "r2" }),
  );
  await until(() => sent.find((m) => m.t === "session.idle" && m.sessionId === id), "idle");
  const live = sent.filter((m) => m.t === "session.event" && m.sessionId === id).map((m) => m.payload);
  expect(live.filter((p) => p.kind === "user_message")).toHaveLength(1);
  expect(live.some((p) => p.update?.content?.text === "Did it")).toBe(true);
  expect(sent.find((m) => m.t === "session.idle").providerId).toBe("ggcoder");
  // Seq'd like everything else.
  const seqs = sent.filter((m) => m.t === "session.event" && m.sessionId === id).map((m) => m.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

  // Cancel is Esc.
  await send({ t: "session.cancel", sessionId: id });
  expect(scripts.at(-1)).toContain("character id 27");

  // The phone's pills drive OG Coder: model by its /model command, thinking by
  // Shift+Tab presses, plan mode refused.
  (daemon as unknown as { sessions: Map<string, { native: { configOptions: unknown[] } }> }).sessions.get(id)!.native.configOptions = [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: "opus", options: [{ value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }] },
    { id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: "high", options: ["off", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, name: value })) },
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
  ];
  await send({ t: "session.config", sessionId: id, configId: "model", value: "sonnet" });
  expect(scripts.some((script) => script.includes('"/model sonnet" newline NO'))).toBe(true);
  expect(desk.model).toBe("Sonnet");
  expect(sent.at(-1)).toMatchObject({ t: "session.config", sessionId: id });
  expect(sent.at(-1).configOptions[0].currentValue).toBe("sonnet");
  // Thinking: Shift+Tab one at a time until the status line says so, whatever
  // the cycle (OG Coder's here runs low → … → max → off).
  await send({ t: "session.config", sessionId: id, configId: "thinking", value: "low" });
  expect(desk.thinking).toBe("low");
  expect(sent.at(-1).configOptions[1].currentValue).toBe("low");
  await send({ t: "session.config", sessionId: id, configId: "mode", value: "plan" });
  expect(replies.at(-1).message).toBe(NATIVE_CONFIG_REFUSAL);

  // The desk talks back: typing in OG Coder becomes a draft from "desk", a
  // clear clears the phone, and a status-line change moves the phone's pills.
  desk.input = "typed at the desk";
  await until(() => sent.find((m) => m.t === "session.draft" && m.from === DESK_DRAFT_FROM && m.text === "typed at the desk"), "desk draft");
  desk.input = "";
  await until(() => sent.find((m) => m.t === "session.draft" && m.from === DESK_DRAFT_FROM && m.text === ""), "desk clear");
  desk.thinking = "max";
  desk.plan = true;
  await until(
    () => sent.find((m) => m.t === "session.config" && m.sessionId === id && m.configOptions[1]?.currentValue === "max" && m.configOptions[2]?.currentValue === "plan"),
    "desk pills",
  );

  // A second device resuming the same conversation is pointed at the mirror.
  const count = sent.filter((m) => m.t === "session.started").length;
  await send({ t: "session.resume", providerId: "ggcoder", agentSessionId: AGENT_ID });
  const again = sent.filter((m) => m.t === "session.started");
  expect(again).toHaveLength(count + 1);
  // Re-keyed, so a phone that saw the old id's events replays them all
  // instead of skipping every one as already seen (the empty-screen bug).
  const reopened = again.at(-1);
  expect(reopened.sessionId).not.toBe(id);
  expect(reopened).toMatchObject({ resumed: true, agentSessionId: AGENT_ID, providerId: "ggcoder" });
  expect(reopened.configOptions.length).toBeGreaterThan(0);
  expect(daemon.isNative(id)).toBe(false);
  expect(daemon.isNative(reopened.sessionId)).toBe(true);
  const replayed = sent
    .filter((m) => m.t === "session.replay" && m.sessionId === reopened.sessionId)
    .flatMap((m) => m.events);
  expect(replayed.some((m) => m.payload?.update?.content?.text === "Did it")).toBe(true);
  const newId = reopened.sessionId;

  // Still the same window: typing reaches it under the new id.
  const sinceReopen = scripts.length;
  await send({ t: "session.draft", sessionId: newId, text: "x" });
  await until(() => scripts.slice(sinceReopen).some((s) => s.includes('write text "x"')), "draft after reopen");

  // The window closes: the mirror is dropped and re-announced, nothing typed.
  const typed = scripts.filter((s) => s.includes("write text")).length;
  alive = false;
  await until(() => sent.findLast((m) => m.t === "providers").activeSessions.length === 0, "teardown");
  expect(daemon.isNative(newId)).toBe(false);
  expect(scripts.filter((s) => s.includes("write text")).length).toBe(typed);
  daemon.closeAll();
});

test("closing the session only stops mirroring: no keys go to the window", async () => {
  const { daemon, sent, scripts, send } = await handoverRig();
  await send({ t: "desk.open", requestId: "r1", sessionId: "ggcoder-old", target: "native" });
  const id = sent.find((m) => m.t === "session.started").sessionId;
  const n = scripts.filter((s) => s.includes("write text")).length;
  await send({ t: "session.close", sessionId: id });
  expect(daemon.isNative(id)).toBe(false);
  expect(scripts.filter((s) => s.includes("write text")).length).toBe(n);
  expect(daemon.reapIdleSessions(Date.now() + 10 ** 9)).toEqual([]);
  daemon.closeAll();
});

test("a new conversation opens the app plain in the project and mirrors what it writes", async () => {
  const { daemon, sent, scripts, send, file } = await handoverRig();
  const directory = path.dirname(file);
  (daemon as any).probes.set("ggcoder", Promise.resolve({ configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "opus", options: [{ value: "opus", name: "Opus" }] }], sessions: [] }));
  (daemon as any).knownProject = async (_p: string, cwd: string) => cwd;
  (daemon as any).nativeOptions.pollMs = 10;
  const NEW_ID = "new-conversation-id";
  // OG Coder writes its header moments after it starts.
  setTimeout(() => {
    void writeFile(path.join(directory, "2026-10-13T20-00-00-000Z_newconv.jsonl"), line({ type: "session", id: NEW_ID, cwd: CWD, timestamp: new Date().toISOString() }));
  }, 30);
  const replies: any[] = [];
  await handleMessage(JSON.stringify({ t: "desk.open", requestId: "n1", target: "native", providerId: "ggcoder", cwd: CWD }), {
    daemon,
    reply: (m: unknown) => replies.push(m),
    broadcast: (m: unknown) => sent.push(m),
  });
  expect(replies.at(-1)).toMatchObject({ t: "desk.opened", ok: true });
  const open = scripts.find((s) => s.includes("create window"))!;
  expect(open).toContain("exec ogcoder");
  expect(open).not.toContain("--resume");
  const started = sent.findLast((m) => m.t === "session.started");
  // New, not a resume: the phone's empty screen takes it.
  expect(started.resumed).toBeUndefined();
  expect(started.agentSessionId).toBe(NEW_ID);
  expect(started.configOptions[0].id).toBe("model");
  expect(daemon.isNative(started.sessionId)).toBe(true);
  void send;
  daemon.closeAll();
});
