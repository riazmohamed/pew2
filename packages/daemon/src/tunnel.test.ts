import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  TUNNEL_COOKIE,
  TunnelManager,
  findNgrok,
  gate,
  ngrokError,
  readCookie,
  startGate,
  stripCookie,
} from "./tunnel.js";

type FakeChild = ChildProcess & { wasKilled: boolean };

/** A stand-in ngrok: prints the lines given, records being killed. */
function fakeNgrok(lines: string[]) {
  const spawned: { args: string[]; child: FakeChild }[] = [];
  const spawnNgrok = (_binary: string, args: string[]) => {
    const child = new EventEmitter() as FakeChild;
    const stdout = new PassThrough();
    Object.assign(child, {
      stdout,
      stderr: new PassThrough(),
      pid: 4242 + spawned.length,
      exitCode: null,
      signalCode: null,
      wasKilled: false,
      kill: () => {
        Object.assign(child, { wasKilled: true, signalCode: "SIGTERM" });
        queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
        return true;
      },
    });
    spawned.push({ args, child });
    queueMicrotask(() => {
      for (const line of lines) stdout.write(`${line}\n`);
    });
    return child;
  };
  return { spawned, spawnNgrok };
}

const PUBLIC = "https://abc.tunnel.test";
const STARTED = JSON.stringify({ lvl: "info", msg: "started tunnel", url: PUBLIC });
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function manager(
  lines: string[],
  extra: Partial<NonNullable<ConstructorParameters<typeof TunnelManager>[0]>> = {},
) {
  const ngrok = fakeNgrok(lines);
  let proxies = 0;
  const m = new TunnelManager({
    binary: () => "/usr/local/bin/ngrok",
    spawnNgrok: ngrok.spawnNgrok,
    startProxy: () => {
      proxies += 1;
      return { port: 50_000 + proxies, stop: () => (proxies -= 1) };
    },
    startTimeoutMs: 500,
    ...extra,
  });
  stops.push(() => m.closeAll());
  return { m, ngrok, proxies: () => proxies };
}

const LISTENING = [{ port: 5173, process: "node" }];

test("only a port the daemon just saw listening is tunnelled; ngrok is not started otherwise", async () => {
  const { m, ngrok } = manager([STARTED]);
  await expect(m.open(3000, LISTENING)).rejects.toThrow("Nothing is listening on port 3000");
  expect(ngrok.spawned).toHaveLength(0);
});

test("ngrok points at the loopback gate, never at the dev server or another host", async () => {
  const { m, ngrok } = manager([STARTED]);
  const info = await m.open(5173, LISTENING);
  expect(ngrok.spawned[0]!.args.slice(0, 2)).toEqual(["http", "http://127.0.0.1:50001"]);
  expect(info.status).toBe("open");
  expect(info.url!.startsWith(`${PUBLIC}/?pew2_key=`)).toBe(true);
  expect(info.url!.split("=")[1]).toHaveLength(32);
});

test("one tunnel per site: a second open returns the same link", async () => {
  const { m, ngrok } = manager([STARTED]);
  const [a, b] = await Promise.all([m.open(5173, LISTENING), m.open(5173, LISTENING)]);
  const c = await m.open(5173, LISTENING);
  expect(ngrok.spawned).toHaveLength(1);
  expect(b.url).toBe(a.url!);
  expect(c.url).toBe(a.url!);
});

test("closing kills the child it spawned and stops the gate", async () => {
  const { m, ngrok, proxies } = manager([STARTED]);
  await m.open(5173, LISTENING);
  expect(m.pids()).toEqual([4242]);
  expect(m.close(5173)).toEqual({ port: 5173, status: "closed" });
  expect(ngrok.spawned[0]!.child.wasKilled).toBe(true);
  expect(proxies()).toBe(0);
  expect(m.list()).toEqual([]);
});

test("closes after the idle limit, and use pushes the limit back", async () => {
  let now = 0;
  const notes: unknown[] = [];
  const { m, ngrok } = manager([STARTED], { now: () => now, idleMs: 1_000 });
  const info = await m.open(5173, LISTENING, (n) => notes.push(n));
  expect(info.idleCloseAt).toBe(1_000);
  now = 900;
  await m.open(5173, LISTENING); // asking again counts as use
  now = 1_500;
  m.sweep();
  expect(m.list()).toHaveLength(1);
  expect(m.list()[0]!.idleCloseAt).toBe(1_900);
  now = 1_900;
  m.sweep();
  expect(m.list()).toEqual([]);
  expect(ngrok.spawned[0]!.child.wasKilled).toBe(true);
  expect(notes).toEqual([
    { port: 5173, status: "closed", message: "Closed after 30 minutes without use." },
  ]);
});

test("ngrok dying on its own closes the link and tells the phone", async () => {
  const notes: unknown[] = [];
  const { m, ngrok } = manager([STARTED]);
  await m.open(5173, LISTENING, (n) => notes.push(n));
  ngrok.spawned[0]!.child.emit("exit", 1, null);
  expect(m.list()).toEqual([]);
  expect(notes).toEqual([
    { port: 5173, status: "closed", message: "The link closed on your computer." },
  ]);
});

test("a refused ngrok session becomes a clear error and nothing is left running", async () => {
  const refused = JSON.stringify({
    lvl: "eror",
    msg: "failed to reconnect session",
    err: "authentication failed: The endpoint is already online. ERR_NGROK_334",
  });
  const { m, ngrok, proxies } = manager([refused]);
  await expect(m.open(5173, LISTENING)).rejects.toThrow("already in use");
  expect(ngrok.spawned[0]!.child.wasKilled).toBe(true);
  expect(proxies()).toBe(0);
  expect(m.list()).toEqual([]);
});

test("no ngrok binary is a plain error, and the ability is not announced", async () => {
  const m = new TunnelManager({ binary: () => undefined });
  expect(m.available()).toBe(false);
  await expect(m.open(5173, LISTENING)).rejects.toThrow("ngrok is not installed");
  expect(new TunnelManager({ binary: () => "/x/ngrok" }).available()).toBe(true);
  expect(findNgrok({ PEW2_NGROK: "off", PATH: "/usr/local/bin" })).toBeUndefined();
  expect(findNgrok({ PATH: "" }, (p) => p === "/opt/homebrew/bin/ngrok")).toBe(
    "/opt/homebrew/bin/ngrok",
  );
});

test("ngrok's errors read as something a person can act on", () => {
  expect(ngrokError("ERR_NGROK_4018 authentication failed")).toContain("not signed in");
  expect(ngrokError("ERR_NGROK_108 limited to 1 simultaneous session")).toContain("one connection");
  expect(ngrokError("The endpoint is already online. ERR_NGROK_334")).toContain("already in use");
  expect(ngrokError("ERR_NGROK_9999 weird")).toBe("ngrok refused the tunnel (ERR_NGROK_9999).");
});

test("the gate: the secret in the URL admits once to the clean path, then only the cookie passes", () => {
  const secret = "s".repeat(32);
  expect(gate(new URL(`${PUBLIC}/app?x=1&pew2_key=${secret}`), null, secret)).toEqual({
    kind: "admit",
    location: "/app?x=1",
  });
  expect(gate(new URL(`${PUBLIC}/?pew2_key=wrong`), null, secret)).toEqual({ kind: "deny" });
  expect(gate(new URL(`${PUBLIC}/`), null, secret)).toEqual({ kind: "deny" });
  expect(gate(new URL(`${PUBLIC}/`), `a=1; ${TUNNEL_COOKIE}=nope`, secret)).toEqual({
    kind: "deny",
  });
  expect(gate(new URL(`${PUBLIC}/`), `a=1; ${TUNNEL_COOKIE}=${secret}`, secret)).toEqual({
    kind: "pass",
  });
  expect(readCookie("a=1; b=2", "b")).toBe("2");
  expect(stripCookie(`a=1; ${TUNNEL_COOKIE}=x; b=2`, TUNNEL_COOKIE)).toBe("a=1; b=2");
  expect(stripCookie(`${TUNNEL_COOKIE}=x`, TUNNEL_COOKIE)).toBeUndefined();
});

test("the gate proxies pages and hot-reload websockets on loopback, and hides its cookie", async () => {
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return undefined;
      return new Response(
        `host=${request.headers.get("host")} cookie=${request.headers.get("cookie")}`,
      );
    },
    websocket: {
      message(ws, message) {
        ws.send(`echo:${String(message)}`);
      },
    },
  });
  stops.push(() => void backend.stop(true));
  let traffic = 0;
  const secret = "k".repeat(32);
  const proxy = startGate({ target: backend.port!, secret, onTraffic: () => (traffic += 1) });
  stops.push(() => proxy.stop());
  const origin = `http://127.0.0.1:${proxy.port}`;

  expect((await fetch(`${origin}/`)).status).toBe(401);
  const admit = await fetch(`${origin}/?pew2_key=${secret}`, { redirect: "manual" });
  expect(admit.status).toBe(302);
  expect(admit.headers.get("set-cookie")).toContain("HttpOnly");
  const page = await fetch(`${origin}/`, {
    headers: { cookie: `${TUNNEL_COOKIE}=${secret}; a=1` },
  });
  expect(await page.text()).toBe(`host=localhost:${backend.port} cookie=a=1`);

  const echoed = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/hmr`, {
      headers: { cookie: `${TUNNEL_COOKIE}=${secret}` },
    } as unknown as string[]);
    ws.onopen = () => ws.send("ping");
    ws.onmessage = (event) => {
      resolve(String(event.data));
      ws.close();
    };
    ws.onerror = () => reject(new Error("websocket failed"));
  });
  expect(echoed).toBe("echo:ping");
  expect(traffic).toBeGreaterThan(2);
});
