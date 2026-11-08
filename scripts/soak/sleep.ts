#!/usr/bin/env bun
/**
 * Sleep simulation: does a phone on the relay get everything after the Mac
 * sleeps, without re-pairing?
 *
 *   bun scripts/soak/sleep.ts [--seconds 70]
 *
 * Starts an isolated daemon (own HOME and PEW2_HOME under /tmp, free port,
 * throwaway token, the echo agent) pointed at a fake relay in this process,
 * which forwards like `packages/relay` (sealed frames stamped with `from`,
 * cleartext passed on, `ping` answered with `pong`). A phone joins through it
 * using the app's own `heartbeat.ts` and its rule of starting over when the
 * computer says hello again. It sends a prompt, then the daemon is paused
 * with SIGSTOP (the lid closed) and resumed with SIGCONT. Passes when the
 * daemon is back through the relay within seconds and the phone holds the
 * whole reply, replayed by cursor. Never touches the launchd daemon.
 */
import { spawn } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { SecureChannel, e2e, wire } from "@pew2/protocol";
import { pairingFromToken } from "../../packages/daemon/src/pairing.ts";
import { createHeartbeat } from "../../packages/app/src/heartbeat.ts";

const REPO = path.resolve(import.meta.dir, "../..");
const secondsArg = process.argv.indexOf("--seconds");
const SLEEP_S = secondsArg > 0 ? Number(process.argv[secondsArg + 1]) : 70;
const ROOT = `/tmp/pew2-sleep-${process.pid}`;
const t0 = Date.now();
const say = (line: string) =>
  console.log(`[sleep +${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`);

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      server.close(() => resolve(address.port));
    });
  });
}

// ------------------------------------------------------------ fake relay
type Peer = { role: string; deviceId: string };
const peers = new Map<import("bun").ServerWebSocket<Peer>, Peer>();
let daemonJoins = 0;
const relay = Bun.serve<Peer>({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request, server) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") ?? "app";
    const deviceId = url.searchParams.get("deviceId") ?? "";
    return server.upgrade(request, { data: { role, deviceId } })
      ? undefined
      : new Response("no", { status: 400 });
  },
  websocket: {
    open(ws) {
      peers.set(ws, ws.data);
      if (ws.data.role === "daemon") daemonJoins += 1;
    },
    message(ws, raw) {
      const text = String(raw);
      if (text === '{"t":"ping"}') return void ws.send('{"t":"pong"}');
      const message = JSON.parse(text);
      // Apps say who they are in their hello; the relay stamps sealed frames.
      if (message.t === "hello" && ws.data.role === "app") ws.data.deviceId = message.deviceId;
      const out = message.t === "e" ? JSON.stringify({ ...message, from: ws.data.deviceId }) : text;
      for (const [peer, info] of peers)
        if (info.role !== ws.data.role && peer.readyState === 1) peer.send(out);
    },
    close(ws) {
      peers.delete(ws);
    },
  },
});

// ------------------------------------------------------------ daemon
const HOME = path.join(ROOT, "home");
const PEW2_HOME = path.join(ROOT, "pew2");
const PROJECT = path.join(ROOT, "project");
for (const dir of [HOME, PEW2_HOME, PROJECT]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(PEW2_HOME, "known-projects.json"), JSON.stringify([PROJECT]));
writeFileSync(path.join(PEW2_HOME, "keep-awake.json"), JSON.stringify({ enabled: false }));
const secret = [...crypto.getRandomValues(new Uint8Array(32))]
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");
const pairing = pairingFromToken(secret);
const port = await freePort();
const daemon = spawn([process.execPath, "run", path.join(REPO, "packages/daemon/src/server.ts")], {
  cwd: REPO,
  env: {
    ...process.env,
    HOME,
    PEW2_HOME,
    PEW2_PORT: String(port),
    PEW2_TOKEN: secret,
    PEW2_RELAY: `ws://127.0.0.1:${relay.port}`,
    PEW2_EXPERIMENTAL: "1",
    OPENAI_API_KEY: "",
    OPENROUTER_API_KEY: "",
  },
  stdout: "pipe",
  stderr: "pipe",
});
for (const stream of [daemon.stdout, daemon.stderr]) {
  void (async () => {
    const decoder = new TextDecoder();
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split("\n"))
        if (line.includes("[relay]")) say(`daemon: ${line.replace(/^\S+\s+/, "")}`);
    }
  })();
}

// ------------------------------------------------------------ phone
const deviceId = "sleep-phone";
let lastSeq = 0;
let sessionId = "";
let text = "";
let idle = false;
let reconnects = 0;
let ws: WebSocket | undefined;
const waiters: ((m: any) => boolean)[] = [];
const seen = (m: any) => {
  for (const w of [...waiters]) if (w(m)) waiters.splice(waiters.indexOf(w), 1);
};
const until = (match: (m: any) => boolean, ms: number, what: string) =>
  new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
    waiters.push((m) => {
      if (!match(m)) return false;
      clearTimeout(timer);
      resolve(m);
      return true;
    });
  });
let channel: SecureChannel;
const send = (message: unknown) => ws?.send(JSON.stringify(channel.seal(message)));
const apply = (seq: number, payload: any) => {
  if (seq <= lastSeq) return;
  lastSeq = seq;
  const update = payload?.update;
  if (update?.sessionUpdate === "agent_message_chunk") {
    for (const block of [update.content].flat())
      if (typeof block?.text === "string") text += block.text;
  }
};

function connect() {
  const socket = new WebSocket(
    `ws://127.0.0.1:${relay.port}/connect?pairing=${pairing.token}&role=app&deviceId=${deviceId}`,
  );
  ws = socket;
  channel = new SecureChannel(e2e.fromHex(pairing.key), "app");
  const heartbeat = createHeartbeat({
    send: () => {
      try {
        socket.send('{"t":"ping"}');
        return true;
      } catch {
        return false;
      }
    },
    dead: (why) => replace(why),
    now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const replace = (why: string) => {
    if (ws !== socket) return;
    say(`phone: ${why}, reconnecting`);
    heartbeat.stop();
    socket.onmessage = null;
    socket.close();
    reconnects += 1;
    connect();
  };
  socket.onopen = () => {
    socket.send(
      JSON.stringify({
        t: "hello",
        wire: wire.WIRE_VERSION,
        role: "app",
        deviceId,
        proof: channel.proof(deviceId),
        cursors: sessionId ? { [sessionId]: lastSeq } : {},
      }),
    );
    heartbeat.start();
  };
  socket.onmessage = (event) => {
    heartbeat.heard(event.data === '{"t":"pong"}');
    const raw = JSON.parse(String(event.data));
    // The app's rule (`daemonConnection.ts`): the computer said hello again.
    if (raw.t === "hello" && raw.role === "daemon") return replace("computer rejoined");
    if (raw.t !== "e") return;
    const message: any = channel.open(raw);
    if (!message) return;
    if (message.t === "session.event" && message.sessionId === sessionId)
      apply(message.seq, message.payload);
    if (message.t === "session.replay" && message.sessionId === sessionId) {
      for (const e of message.events ?? []) apply(e.seq, e.payload);
      if (message.working === false) idle = true;
    }
    if (message.t === "session.idle" && message.sessionId === sessionId) idle = true;
    seen(message);
  };
}

let ok = false;
try {
  connect();
  await until((m) => m.t === "device.joined", 30_000, "phone joined through the relay");
  say("phone joined through the relay");
  const started = until((m) => m.t === "session.started", 30_000, "session.started");
  send({ t: "session.start", requestId: "r1", providerId: "echo", cwd: PROJECT });
  sessionId = (await started).sessionId;
  send({ t: "session.prompt", sessionId, text: "the reply that straddles the sleep" });
  await until((m) => m.t === "session.event", 15_000, "first chunk");
  const joinsBefore = daemonJoins;
  process.kill(daemon.pid, "SIGSTOP");
  say(`daemon paused (SIGSTOP) for ${SLEEP_S}s, seq ${lastSeq}`);
  await Bun.sleep(SLEEP_S * 1000);
  process.kill(daemon.pid, "SIGCONT");
  const resumedAt = Date.now();
  say("daemon resumed (SIGCONT)");
  while (daemonJoins === joinsBefore && Date.now() - resumedAt < 30_000) await Bun.sleep(100);
  const back = (Date.now() - resumedAt) / 1000;
  if (daemonJoins === joinsBefore) throw new Error("daemon did not reconnect to the relay in 30s");
  say(`daemon back on the relay ${back.toFixed(1)}s after resume`);
  const deadline = Date.now() + 30_000;
  while (!idle && Date.now() < deadline) await Bun.sleep(100);
  say(
    `phone: idle=${idle} seq=${lastSeq} reconnects=${reconnects} text=${JSON.stringify(text.slice(0, 80))}`,
  );
  ok = idle && text.length > 0 && back < 10;
} catch (error) {
  say(`FAIL ${(error as Error).message}`);
} finally {
  process.kill(daemon.pid, "SIGCONT");
  daemon.kill();
  await daemon.exited;
  void relay.stop(true);
  rmSync(ROOT, { recursive: true, force: true });
}
say(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
