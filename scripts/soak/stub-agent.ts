#!/usr/bin/env bun
/**
 * A stub OG Coder for the soak daemon: a real ACP agent over stdio that never
 * calls a model (no OpenRouter credits), and writes the same conversation file
 * GG Coder does (`~/.gg/sessions/<encoded cwd>/<time>_<id8>.jsonl`), so the
 * daemon's handover to the GG Coder app finds and mirrors it exactly as it
 * would a real one.
 *
 * Each process records the conversations it is bound to in
 * `$PEW2_SOAK_DIR/agents/<pid>.json`, removed on exit: that is how the harness
 * counts writers per conversation ("one agent per conversation").
 *
 * Prompts are scripted by the harness: `WORK:<n>` runs n streamed tool steps
 * (`bash(echo …)` with output), anything else gets a short streamed reply.
 */
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { encodeCwd } from "../../packages/daemon/src/acp/ggcoder-history.ts";

const soakDir = process.env.PEW2_SOAK_DIR ?? "";
const marker = soakDir ? path.join(soakDir, "agents", `${process.pid}.json`) : "";
const bound = new Map<string, { file: string; cwd: string; last: string | null }>();
const cancelled = new Set<string>();

function record(): void {
  if (!marker) return;
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(
    marker,
    JSON.stringify({ pid: process.pid, sessions: [...bound.keys()], at: Date.now() }),
  );
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(signal, () => process.exit(0));
process.on("exit", () => {
  if (marker) rmSync(marker, { force: true });
});
record();

let counter = 0;
const uuid = () => crypto.randomUUID();

function sessionsDir(cwd: string): string {
  return path.join(homedir(), ".gg", "sessions", encodeCwd(cwd));
}

/** A new conversation file with GG Coder's header line. */
function newConversation(cwd: string): { id: string; file: string } {
  const id = uuid();
  const dir = sessionsDir(cwd);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}_${id.slice(0, 8)}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session", id, conversationId: id, cwd, timestamp: new Date().toISOString() })}\n`,
  );
  return { id, file };
}

function append(sessionId: string, role: string, content: unknown): void {
  const conv = bound.get(sessionId);
  if (!conv) return;
  const id = `stub-${process.pid}-${++counter}`;
  appendFileSync(
    conv.file,
    `${JSON.stringify({ type: "message", id, parentId: conv.last, timestamp: new Date().toISOString(), message: { role, content } })}\n`,
  );
  conv.last = id;
}

async function beat(sessionId: string, ms: number): Promise<boolean> {
  if (cancelled.has(sessionId)) return false;
  await new Promise((resolve) => setTimeout(resolve, ms));
  return !cancelled.has(sessionId);
}

const app = agent({ name: "pew2-soak-ogcoder" })
  .onRequest("initialize", async () => ({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {} },
      promptCapabilities: { image: false },
    },
    agentInfo: { name: "pew2-soak-ogcoder", title: "OG Coder (soak stub)", version: "0.0.0" },
    authMethods: [],
  }))
  .onRequest("session/new", async (ctx) => {
    const cwd = (ctx.params as { cwd?: string })?.cwd ?? process.cwd();
    const { id, file } = newConversation(cwd);
    bound.set(id, { file, cwd, last: null });
    record();
    return { sessionId: id, configOptions: [] };
  })
  .onRequest("session/list", async () => ({ sessions: [] }))
  .onRequest("session/resume", async (ctx) => {
    const { sessionId, cwd } = ctx.params as { sessionId: string; cwd?: string };
    const dir = sessionsDir(cwd ?? process.cwd());
    const file = (
      await Array.fromAsync(new Bun.Glob(`*_${sessionId.slice(0, 8)}.jsonl`).scan(dir))
    )[0];
    bound.set(sessionId, {
      file: file ? path.join(dir, file) : newConversation(cwd ?? process.cwd()).file,
      cwd: cwd ?? process.cwd(),
      last: null,
    });
    record();
    return { configOptions: [] };
  })
  .onRequest("session/load", async (ctx) => {
    const { sessionId, cwd } = ctx.params as { sessionId: string; cwd?: string };
    const dir = sessionsDir(cwd ?? process.cwd());
    const file = (
      await Array.fromAsync(new Bun.Glob(`*_${sessionId.slice(0, 8)}.jsonl`).scan(dir))
    )[0];
    bound.set(sessionId, {
      file: file ? path.join(dir, file) : newConversation(cwd ?? process.cwd()).file,
      cwd: cwd ?? process.cwd(),
      last: null,
    });
    record();
    return { configOptions: [] };
  })
  .onNotification("session/cancel", async (ctx) => {
    const { sessionId } = (ctx.params ?? {}) as { sessionId?: string };
    if (sessionId) cancelled.add(sessionId);
  })
  .onRequest("session/prompt", async (ctx) => {
    const { sessionId, prompt } = ctx.params as {
      sessionId: string;
      prompt: { type: string; text?: string }[];
    };
    cancelled.delete(sessionId);
    const text = prompt
      .map((p) => p.text ?? "")
      .join(" ")
      .trim();
    append(sessionId, "user", [{ type: "text", text }]);
    const say = async (chunk: string) => {
      await ctx.client.notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } },
      });
    };
    const work = /WORK:(\d+):(\S+)/.exec(text);
    if (work) {
      const steps = Number(work[1]);
      const nonce = work[2]!;
      for (let i = 1; i <= steps; i++) {
        const toolCallId = `stub-tool-${nonce}-${i}`;
        const command = `echo step-${i}-${nonce}`;
        append(sessionId, "assistant", [
          { type: "tool_call", id: toolCallId, name: "bash", args: { command } },
        ]);
        await ctx.client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: `bash(${command})`,
            kind: "execute",
            status: "in_progress",
            rawInput: { command },
          },
        });
        if (!(await beat(sessionId, 40))) return { stopReason: "cancelled" };
        const output = `out-${i}-${nonce}`;
        append(sessionId, "tool", [{ type: "tool_result", toolCallId, content: output }]);
        await ctx.client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: output } }],
          },
        });
      }
    }
    const reply = `Done (${text.slice(0, 40)}).`;
    for (const word of reply.split(" ")) {
      await say(`${word} `);
      if (!(await beat(sessionId, 15))) return { stopReason: "cancelled" };
    }
    append(sessionId, "assistant", [{ type: "text", text: reply }]);
    return { stopReason: "end_turn" };
  });

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
