/**
 * Driving with Pew: switching a chat's model by voice, and the ring when work
 * handed over on a call is done. A real Daemon, handler and the echo agent.
 */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMessage } from "../handler.js";
import { Daemon } from "../index.js";

async function call(prefs?: object) {
  const root = mkdtempSync(join(tmpdir(), "pew2-drive-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PEW2_HOME: join(root, "pew2"),
    GG_AGENT_DIR: join(root, "gg"),
    CODEX_HOME: join(root, "codex"),
    OPENAI_API_KEY: "sk-test",
  };
  const daemon = new Daemon({ id: "t", name: "t" }, true, env);
  const sent: any[] = [];
  daemon.attach((message) => sent.push(message));
  (daemon.voice as any).fetchImpl = async () =>
    new Response(JSON.stringify({ value: "ek_test", expires_at: 9_999_999_999, session: { model: "m" } }));
  const replies: any[] = [];
  const ctx = { daemon, reply: (m: unknown) => replies.push(m), broadcast: (m: unknown) => sent.push(m) };
  await daemon.refreshProviders();
  if (prefs) await daemon.voice.setPrefs(prefs);
  const sessionId = await daemon.startSession("echo", process.cwd());
  daemon.markLive(sessionId);
  await handleMessage(JSON.stringify({ t: "voice.session", requestId: "v" }), ctx);
  const { callId } = replies.at(-1);
  let n = 0;
  const tool = async (name: string, args: object) => {
    await handleMessage(
      JSON.stringify({ t: "voice.tool", requestId: `r${++n}`, callId, toolCallId: `t${n}`, name, arguments: JSON.stringify(args) }),
      ctx,
    );
    return JSON.parse(replies.at(-1).output);
  };
  return { daemon, sent, ctx, sessionId, callId, tool };
}

test("set_model switches the chat by a spoken name, and the phone's pills follow", async () => {
  const { daemon, sent, sessionId, tool } = await call();
  try {
    // The echo agent starts on a random model: ask for one it isn't on.
    const before = daemon.configOptions(sessionId).find((option) => option.id === "model")?.currentValue;
    const [target, spoken, label] = before === "echo-mini" ? ["echo-max", "max", "Echo Max"] : ["echo-mini", "mini", "Echo Mini"];
    const result = await tool("set_model", { session_id: sessionId, model: spoken });
    expect(result).toMatchObject({ ok: true });
    expect(result.say).toContain(`${label} now`);
    const model = daemon.configOptions(sessionId).find((option) => option.id === "model");
    expect(model?.currentValue).toBe(target);
    expect(sent.some((m) => m.t === "session.config" && m.sessionId === sessionId)).toBe(true);
    // Already on it: says so, changes nothing.
    expect((await tool("set_model", { session_id: sessionId, model: spoken })).say).toContain("already");
    // Asking what there is lists, and switches nothing.
    const listed = await tool("list_models", { session_id: sessionId });
    expect(listed).toMatchObject({ ok: true, current: label });
    expect(listed.models).toContain("Echo Pro");
    expect(daemon.configOptions(sessionId).find((option) => option.id === "model")?.currentValue).toBe(target);
    // A model it doesn't have is said plainly.
    expect(await tool("set_model", { session_id: sessionId, model: "llama" })).toMatchObject({ ok: false });
  } finally {
    daemon.closeAll();
  }
}, 60_000);

test("work handed to a chat on a call rings when it is done, with Ring me on", async () => {
  const { daemon, sessionId, tool, ctx, callId } = await call({ mode: "onthego", ringUntil: 0 });
  try {
    expect(await tool("tell_agent", { session_id: sessionId, text: "run the tests" })).toMatchObject({ ok: true });
    await handleMessage(JSON.stringify({ t: "voice.end", callId }), ctx);
    expect((daemon.voice as any).waitingOn?.sessionId).toBe(sessionId);
    // The ring's call opens with that project's news.
    expect((daemon.voice as any).callbackAbout).toMatchObject({ handed: true });
  } finally {
    daemon.closeAll();
  }
}, 60_000);

test("with Ring me off, handing work over books no ring", async () => {
  const { daemon, sessionId, tool, ctx, callId } = await call();
  try {
    await tool("tell_agent", { session_id: sessionId, text: "run the tests" });
    await handleMessage(JSON.stringify({ t: "voice.end", callId }), ctx);
    expect((daemon.voice as any).waitingOn).toBeUndefined();
  } finally {
    daemon.closeAll();
  }
}, 60_000);

test("a call that only looked hands nothing over, so nothing rings", async () => {
  const { daemon, tool, ctx, callId } = await call({ mode: "onthego", ringUntil: 0 });
  try {
    await tool("get_status", {});
    await handleMessage(JSON.stringify({ t: "voice.end", callId }), ctx);
    expect((daemon.voice as any).waitingOn).toBeUndefined();
  } finally {
    daemon.closeAll();
  }
}, 60_000);

test("a turn that failed on a usage limit shows in get_status and the briefing; a clean turn clears it", async () => {
  const { daemon, sessionId, tool } = await call();
  try {
    daemon.noteTurnEnd(sessionId, "Claude Code: You've hit your session limit · resets 8:50pm");
    const status = await tool("get_status", { session_id: sessionId });
    expect(status.sessions[0].hit_usage_limit).toContain("session limit");
    expect(daemon.voiceStatuses(sessionId)[0]?.limit).toContain("resets 8:50pm");
    daemon.noteTurnEnd(sessionId, "Agent crashed: exit 1");
    expect(daemon.voiceStatuses(sessionId)[0]?.limit).toBeUndefined();
    daemon.noteTurnEnd(sessionId, "429 rate_limit_error");
    daemon.noteTurnEnd(sessionId);
    expect(daemon.voiceStatuses(sessionId)[0]?.limit).toBeUndefined();
  } finally {
    daemon.closeAll();
  }
}, 60_000);
