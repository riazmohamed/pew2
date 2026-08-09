#!/usr/bin/env bun
/**
 * An ACP front end for GG Coder / ogcoder, which does not speak ACP.
 *
 * The bundled `providers/ggcoder.json` runs `ggcoder acp`, and that subcommand
 * does not exist: GG Coder v5.24 exposes `--rpc`, a line-delimited protocol of
 * its own keyed on `command` rather than JSON-RPC's `method`, with events
 * pushed on a bus instead of `session/update` notifications. So pew2 detects
 * the agent, fails the handshake, and the app shows no GG Coder entry.
 *
 * This process sits between the two: ACP on stdio facing the daemon, one
 * `ogcoder --rpc` child per session facing the agent.
 *
 * Two shape mismatches are worth naming, because they drive the design:
 *
 *   1. **A child is a session.** `--rpc` opens its conversation on spawn and
 *      takes its working directory from `process.cwd()` — there is no command
 *      to change either. ACP hands a `cwd` to `session/new`, so the only way to
 *      honour it is one child per session, spawned in that directory.
 *   2. **Abort is fatal.** `{command:"abort"}` trips the `AbortController` that
 *      the whole session was built with, so the child cannot serve another turn
 *      afterwards. A cancel therefore kills the child, and the next prompt
 *      respawns it. History is GG Coder's own (`~/.gg/sessions`), not ours, so
 *      what is lost is the in-memory context — stated here rather than
 *      discovered when a cancelled thread answers as if it just woke up.
 */
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { resolveOgcoderBin } from "./ogcoder-binary.js";
import { modelConfigOption, providerForModel, type ConfigOption } from "./ogcoder-models.js";
import { listStoredSessions } from "./ogcoder-sessions.js";
import { toolKind, toolTitle } from "./ogcoder-tools.js";

/**
 * The binary to drive.
 *
 * Resolved once, at startup: the upstream CLI is `ggcoder` and the fork is
 * `ogcoder`, and the daemon's launchd PATH omits the directory either normally
 * installs into. Failing here, loudly, beats spawning `ogcoder` per session and
 * reporting ENOENT as a handshake failure.
 */
const resolved = resolveOgcoderBin();
if (!resolved) {
  process.stderr.write(
    "GG Coder not found. Install it, or set PEW2_OGCODER_BIN to the binary's path.\n",
  );
  process.exit(1);
}
const OGCODER_BIN: string = resolved;

/** What the child reports about itself once booted. */
interface RpcState {
  provider?: string;
  model?: string;
  sessionId?: string;
}

/** Events `ogcoder --rpc` pushes without being asked. */
type RpcEvent =
  | { type: "ready"; state?: RpcState }
  | { type: "session_start"; sessionId?: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; toolCallId: string; name: string; args?: Record<string, unknown> }
  | { type: "tool_call_end"; toolCallId: string; isError?: boolean }
  | { type: "error"; message: string };

/** Replies to a command, correlated by the `id` we sent. */
type RpcReply =
  | { id: string; type: "result"; data?: unknown }
  | { id: string; type: "error"; message: string };

type RpcLine = RpcEvent | RpcReply;

function isReply(line: RpcLine): line is RpcReply {
  return "id" in line && (line.type === "result" || line.type === "error");
}

/** One `ogcoder --rpc` child, plus the turn currently running on it. */
interface Session {
  child: ChildProcessWithoutNullStreams;
  cwd: string;
  /** Resolves when the child announces `ready`, so no prompt races the boot. */
  ready: Promise<void>;
  /** Set while a turn is in flight; resolved by the matching reply. */
  pending?: { id: string; settle: (reply: RpcReply) => void };
  /** Cancelled turns must report `cancelled`, not `end_turn`. */
  cancelled: boolean;
  /** Notifier for the session that owns this child. */
  emit: (update: Record<string, unknown>) => Promise<void>;
  /** The model the child booted with, so the picker opens on the truth. */
  model?: string;
  /**
   * The GG Coder conversation this session corresponds to.
   *
   * Passed to `--resume` on respawn. See `start()` for why that currently
   * restores nothing.
   */
  resumeId?: string;
}

const sessions = new Map<string, Session>();
let sessionCounter = 0;
let commandCounter = 0;

/**
 * Spawn a child and wire its stdout to ACP notifications.
 *
 * Every line the child prints is either an event for the phone or the reply
 * that ends a turn; nothing else is expected, and anything unparseable is
 * dropped rather than crashing a live session.
 */
/**
 * Spawn a child, optionally pointed at a stored conversation.
 *
 * **`--resume` does not work in `--rpc` mode.** `AgentSession` supports it
 * through its `sessionId` option, and the Ink TUI uses that, but `runRpcMode`
 * never plumbs the flag through — so the child parses `--resume`, ignores it,
 * and starts an empty conversation. It is passed anyway because the day that
 * gap is closed upstream, this becomes correct with no change here.
 *
 * The consequence, stated plainly because it is invisible from the app: opening
 * a stored thread paints its full transcript (the daemon reads GG Coder's JSONL
 * itself) while the agent behind it has no memory of any of it. Fixing that
 * needs ~6 lines in the fork's `modes/rpc-mode.ts`, not a change in pew2.
 */
function start(
  sessionId: string,
  cwd: string,
  emit: Session["emit"],
  resumeId?: string,
): Session {
  const child = spawn(OGCODER_BIN, resumeId ? ["--rpc", "--resume", resumeId] : ["--rpc"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  let announceReady: () => void = () => {};
  let failReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    announceReady = resolve;
    failReady = reject;
  });

  const session: Session = { child, cwd, ready, cancelled: false, emit, resumeId };

  // stderr is the agent's own diagnostics. Forwarding it keeps `pew2 doctor`
  // and the daemon log useful when a spawn fails for an environmental reason.
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));

  child.on("error", (error) => failReady(error));
  child.on("exit", (code) => {
    failReady(new Error(`${OGCODER_BIN} exited with code ${code ?? "unknown"}`));
    // A turn waiting on a dead child would hang the phone forever.
    session.pending?.settle({
      id: session.pending.id,
      type: "error",
      message: `${OGCODER_BIN} exited during the turn`,
    });
    session.pending = undefined;
  });

  const lines = createInterface({ input: child.stdout, terminal: false });
  void (async () => {
    for await (const raw of lines) {
      if (!raw.trim()) continue;
      let line: RpcLine;
      try {
        line = JSON.parse(raw) as RpcLine;
      } catch {
        continue;
      }

      if (isReply(line)) {
        if (session.pending?.id === line.id) {
          const { settle } = session.pending;
          session.pending = undefined;
          settle(line);
        }
        continue;
      }

      switch (line.type) {
        case "ready":
          session.model = line.state?.model;
          // The child's own id is what `--resume` will need later, and it is
          // only knowable from here: ACP session ids are ours, not GG Coder's.
          if (line.state?.sessionId) session.resumeId = line.state.sessionId;
          announceReady();
          break;
        case "session_start":
          if (line.sessionId) session.resumeId = line.sessionId;
          break;
        case "text_delta":
          await emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: line.text },
          });
          break;
        case "thinking_delta":
          await emit({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: line.text },
          });
          break;
        case "tool_call_start":
          await emit({
            sessionUpdate: "tool_call",
            toolCallId: line.toolCallId,
            title: toolTitle(line.name, line.args),
            kind: toolKind(line.name),
            status: "in_progress",
          });
          break;
        case "tool_call_end":
          await emit({
            sessionUpdate: "tool_call_update",
            toolCallId: line.toolCallId,
            status: line.isError ? "failed" : "completed",
          });
          break;
        case "error":
          // Surfaced as agent prose: a mid-turn provider failure that vanished
          // silently would look to the user like the agent simply stopped.
          await emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `\n⚠️ ${line.message}\n` },
          });
          break;
        default:
          break;
      }
    }
  })();

  return session;
}

/** Send one command and wait for the reply that carries its id. */
function send(session: Session, command: Record<string, unknown>): Promise<RpcReply> {
  const id = `pew2_${++commandCounter}`;
  return new Promise<RpcReply>((resolve) => {
    session.pending = { id, settle: resolve };
    session.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  });
}

/**
 * The config options for a session, currently just the model picker.
 *
 * Thinking level is deliberately absent. `--rpc` takes it as a constructor
 * option and exposes no command to change it, so the only way to honour a
 * change would be to respawn the child — silently discarding the conversation
 * to satisfy a dropdown. A control that is missing is better than one that
 * destroys context when used.
 */
async function configOptionsFor(session: Session): Promise<ConfigOption[]> {
  const model = await modelConfigOption({ bin: OGCODER_BIN, currentModel: session.model });
  return model ? [model] : [];
}

const app = agent({ name: "pew2-ogcoder" })
  .onRequest("initialize", async () => ({
    protocolVersion: 1,
    agentCapabilities: {
      // History comes from GG Coder's own JSONL store, which the daemon reads
      // directly for this provider; `session/load` reattaches the process to
      // that conversation rather than replaying it down the wire.
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {} },
      promptCapabilities: { image: false },
    },
    agentInfo: { name: "pew2-ogcoder", title: "GG Coder", version: "1.0.0" },
    authMethods: [],
  }))
  .onRequest("session/new", async (ctx: { params?: { cwd?: string }; client: AcpClient }) => {
    const cwd = ctx.params?.cwd ?? process.cwd();
    const sessionId = `ogcoder_${++sessionCounter}`;
    const session = start(sessionId, cwd, (update) =>
      ctx.client.notify("session/update", { sessionId, update }),
    );
    sessions.set(sessionId, session);
    // Surfacing a boot failure here, rather than on the first prompt, is what
    // makes `pew2 providers verify ggcoder` mean anything.
    await session.ready;
    return { sessionId, configOptions: await configOptionsFor(session) };
  })
  /**
   * Previous conversations, read from GG Coder's store.
   *
   * The daemon calls this with no `cwd` and folds the result into the app's
   * project picker, so an unfiltered call must return *every* project's
   * sessions. Narrowing it to one directory — or worse, to `process.cwd()`,
   * which is `/` under launchd — leaves the picker searching for folders that
   * never arrive.
   *
   * The ids returned are GG Coder's own, so `session/load` can hand one straight
   * to `--resume` and the daemon can find the matching JSONL file to paint from.
   */
  .onRequest("session/list", async (ctx: { params?: { cwd?: string | null } }) => {
    const cwd = ctx.params?.cwd ?? undefined;
    const stored = await listStoredSessions(cwd);
    return {
      sessions: stored.flatMap((entry) => {
        // A session whose header carries no cwd cannot be attributed to a
        // project. Listing it under a guessed directory would put a
        // conversation in the wrong folder in the picker.
        const home = entry.cwd || cwd;
        return home
          ? [
              {
                sessionId: entry.sessionId,
                cwd: home,
                title: entry.title,
                updatedAt: entry.updatedAt,
              },
            ]
          : [];
      }),
    };
  })
  /**
   * Reattach to a stored conversation.
   *
   * Nothing is replayed: the daemon paints this provider's history from disk
   * and suppresses a duplicate replay anyway, so streaming thousands of
   * notifications here would be work done twice and discarded once.
   */
  .onRequest(
    "session/load",
    async (ctx: { params: { sessionId: string; cwd?: string | null }; client: AcpClient }) => {
      const { sessionId } = ctx.params;
      const cwd = ctx.params.cwd ?? process.cwd();
      const session = start(
        sessionId,
        cwd,
        (update) => ctx.client.notify("session/update", { sessionId, update }),
        sessionId,
      );
      sessions.set(sessionId, session);
      await session.ready;
      return { configOptions: await configOptionsFor(session) };
    },
  )
  /**
   * Change the model on a live session.
   *
   * `switch_model` needs the provider as well as the model id, and the phone
   * only sends the id — so the registry is consulted to recover it. The
   * complete option list must come back, not just the change.
   */
  .onRequest(
    "session/set_config_option",
    async (ctx: {
      params: { sessionId: string; configId: string; value: string | boolean };
    }) => {
      const { sessionId, configId, value } = ctx.params;
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Unknown session '${sessionId}'`);
      if (configId !== "model") throw new Error(`Unknown config option '${configId}'`);
      // Only `select` options are advertised, so a boolean here is a client
      // sending something this agent never offered.
      if (typeof value !== "string") throw new Error(`'${configId}' expects a model id`);

      const provider = await providerForModel(OGCODER_BIN, value);
      if (!provider) throw new Error(`Unknown model '${value}'`);

      const reply = await send(session, { command: "switch_model", provider, model: value });
      if (reply.type === "error") throw new Error(reply.message);
      session.model = value;
      return { configOptions: await configOptionsFor(session) };
    },
  )
  .onNotification("session/cancel", async (ctx: { params?: { sessionId?: string } }) => {
    const session = ctx.params?.sessionId ? sessions.get(ctx.params.sessionId) : undefined;
    if (!session) return;
    session.cancelled = true;
    // `abort` poisons the child's AbortController, so it cannot be reused.
    // Killing it is the honest end; the next prompt spawns a fresh one.
    session.child.kill("SIGTERM");
  })
  .onRequest(
    "session/prompt",
    async (ctx: {
      params: { sessionId: string; prompt: { type: string; text?: string }[] };
      client: AcpClient;
    }) => {
      const { sessionId, prompt } = ctx.params;
      let session = sessions.get(sessionId);
      if (!session) throw new Error(`Unknown session '${sessionId}'`);

      // Respawn after a cancel, in the same directory, so the thread continues
      // to work even though the previous child was killed to stop it.
      if (session.child.exitCode !== null || session.child.signalCode !== null) {
        session = start(sessionId, session.cwd, session.emit, session.resumeId);
        sessions.set(sessionId, session);
        await session.ready;
      }
      session.cancelled = false;

      const text = prompt
        .map((part) => part.text ?? "")
        .join(" ")
        .trim();

      const reply = await send(session, { command: "prompt", text });
      if (session.cancelled) return { stopReason: "cancelled" };
      if (reply.type === "error") throw new Error(reply.message);
      return { stopReason: "end_turn" };
    },
  );

/** The half of the ACP connection this agent talks back through. */
interface AcpClient {
  notify: (method: string, params: unknown) => Promise<void>;
}

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
