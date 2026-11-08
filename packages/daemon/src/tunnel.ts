/**
 * "Open live anywhere": a private ngrok link to a site the agent is running.
 *
 * Open live (a LAN address) needs the phone on the desktop's Wi-Fi, and the
 * snapshot is a picture. This is the live page from anywhere: ngrok gives a
 * public https address, and the daemon puts a small gate in front of the dev
 * server so that address shows nothing without a secret only the phone has.
 *
 * Why a gate here and not ngrok's own auth. This account's plan does accept
 * `--basic-auth`, but a phone browser then asks the user to type a username
 * and password (Chrome drops `user:pass@` from a URL), and OAuth would tie the
 * preview to a Google login. The gate takes the secret once in the first URL,
 * swaps it for an HttpOnly cookie and redirects to the clean address, so the
 * page, its assets and the dev server's hot-reload websocket all just work.
 *
 * The same rules as the snapshot hold: a *port*, never a URL; the port must be
 * one the daemon just saw listening; the upstream host is always 127.0.0.1.
 * One tunnel per port, closed after 30 minutes with no traffic, on request,
 * and when the daemon stops. The ngrok child is killed by its own PID.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import type { ListeningPort } from "./preview.js";
import { findOnPath } from "./providers/registry.js";

/** No traffic for this long and the tunnel closes. */
export const TUNNEL_IDLE_MS = 30 * 60_000;
/** ngrok normally names its URL within a couple of seconds. */
const START_TIMEOUT_MS = 20_000;
/** First-visit query parameter carrying the secret. */
export const TUNNEL_KEY_PARAM = "pew2_key";
/** Cookie the secret is swapped into after the first visit. */
export const TUNNEL_COOKIE = "pew2_preview";

/** Where ngrok usually lives when launchd's PATH does not include it. */
const NGROK_FALLBACKS = ["/usr/local/bin/ngrok", "/opt/homebrew/bin/ngrok"];

/** The ngrok binary, or undefined when this machine has none. */
export function findNgrok(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (env.PEW2_NGROK === "off") return undefined;
  const onPath = findOnPath("ngrok", env);
  if (onPath) return onPath;
  return NGROK_FALLBACKS.find((path) => exists(path));
}

/** Constant-time compare of a presented secret against the real one. */
export function secretMatches(presented: string | null | undefined, secret: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One cookie's value out of a `Cookie` header. */
export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/** The `Cookie` header with pew2's own cookie removed, so the dev server never sees it. */
export function stripCookie(header: string | null, name: string): string | undefined {
  const kept = (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part.split("=")[0]!.trim() !== name);
  return kept.length > 0 ? kept.join("; ") : undefined;
}

export type GateDecision =
  | { kind: "pass" }
  /** Right secret in the URL: set the cookie and send the browser to the clean URL. */
  | { kind: "admit"; location: string }
  | { kind: "deny" };

/** Does this request get through the gate? Pure, so it is tested without sockets. */
export function gate(url: URL, cookieHeader: string | null, secret: string): GateDecision {
  const presented = url.searchParams.get(TUNNEL_KEY_PARAM);
  if (presented !== null) {
    if (!secretMatches(presented, secret)) return { kind: "deny" };
    const clean = new URL(url);
    clean.searchParams.delete(TUNNEL_KEY_PARAM);
    return { kind: "admit", location: `${clean.pathname}${clean.search}${clean.hash}` };
  }
  return secretMatches(readCookie(cookieHeader, TUNNEL_COOKIE), secret)
    ? { kind: "pass" }
    : { kind: "deny" };
}

/**
 * The phone-facing words for an ngrok failure. ngrok's own text names its
 * error codes; the ones a person can act on get a sentence, the rest keep the
 * code so it can be looked up. Never echoes ngrok's config or token.
 */
export function ngrokError(text: string): string {
  const code = /ERR_NGROK_(\d+)/.exec(text)?.[1];
  if (code === "4018" || /authtoken.*(required|missing)|sign up/i.test(text)) {
    return "ngrok is not signed in on your computer. Run 'ngrok config add-authtoken' there, then try again.";
  }
  if (code === "105" || code === "107" || /authtoken.*invalid/i.test(text)) {
    return "ngrok's sign-in on your computer is no longer valid. Add a new authtoken there, then try again.";
  }
  if (code === "108") {
    return "Your ngrok plan allows one connection at a time, and one is already open, maybe on another computer. Close it, then try again.";
  }
  if (code === "334" || /already online/i.test(text)) {
    return "Your ngrok address is already in use, by another open site or another computer. Close that one, then try again.";
  }
  if (code) return `ngrok refused the tunnel (ERR_NGROK_${code}).`;
  const line = text.trim().split("\n").pop()?.slice(0, 200);
  return line ? `ngrok could not start: ${line}` : "ngrok could not start.";
}

/** What the phone is told about one port's tunnel. Mirrors `wire.PreviewTunnelState`. */
export interface TunnelInfo {
  port: number;
  status: "open" | "closed" | "error";
  /** The first-visit address, secret included. Only while open. */
  url?: string;
  /** When it will close if nothing uses it before then (epoch ms). */
  idleCloseAt?: number;
  message?: string;
}

/** The parts of a running proxy the manager needs; a seam for tests. */
interface Proxy {
  port: number;
  stop(): void;
}

interface Tunnel {
  port: number;
  secret: string;
  url: string;
  child: ChildProcess;
  proxy: Proxy;
  lastUsed: number;
  notify?: (info: TunnelInfo) => void;
}

/** A response header that must not be copied as-is from upstream to the browser. */
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

/**
 * The gate: an HTTP + websocket reverse proxy on 127.0.0.1 in front of one dev
 * server. ngrok points at this, never at the dev server itself.
 */
export function startGate(options: {
  target: number;
  secret: string;
  onTraffic: () => void;
}): Proxy {
  const { target, secret, onTraffic } = options;
  type Link = { upstream: WebSocket; queue: (string | Buffer)[] };
  const upstreamHeaders = (request: Request): Headers => {
    const headers = new Headers(request.headers);
    // Dev servers check Host (Vite's allowedHosts); to them this is a local visit.
    headers.set("host", `localhost:${target}`);
    // fetch would decompress the body but keep the header: ask for it plain.
    headers.delete("accept-encoding");
    const cookie = stripCookie(request.headers.get("cookie"), TUNNEL_COOKIE);
    if (cookie) headers.set("cookie", cookie);
    else headers.delete("cookie");
    return headers;
  };
  const server = Bun.serve<Link, never>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, srv) {
      const url = new URL(request.url);
      const decision = gate(url, request.headers.get("cookie"), secret);
      if (decision.kind === "deny") {
        return new Response(
          "<!doctype html><meta name=viewport content='width=device-width'><p style='font:16px system-ui;margin:2em'>This preview is private. Open it from pew2 on your phone.</p>",
          { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      onTraffic();
      if (decision.kind === "admit") {
        return new Response(null, {
          status: 302,
          headers: {
            location: decision.location,
            "set-cookie": `${TUNNEL_COOKIE}=${secret}; Path=/; HttpOnly; Secure; SameSite=Lax`,
            "cache-control": "no-store",
          },
        });
      }
      const path = `${url.pathname}${url.search}`;
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const offered = request.headers.get("sec-websocket-protocol");
        const protocols = offered ? offered.split(",").map((p) => p.trim()) : undefined;
        // Bun echoes the client's first subprotocol on its own; passing it
        // again doubles the header and the browser drops the connection.
        const upstream = new WebSocket(`ws://127.0.0.1:${target}${path}`, protocols);
        upstream.binaryType = "arraybuffer";
        if (srv.upgrade(request, { data: { upstream, queue: [] } })) return undefined;
        upstream.close();
        return new Response("Websocket upgrade failed", { status: 400 });
      }
      try {
        const upstream = await fetch(`http://127.0.0.1:${target}${path}`, {
          method: request.method,
          headers: upstreamHeaders(request),
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
          redirect: "manual",
        });
        const headers = new Headers();
        upstream.headers.forEach((value, key) => {
          if (HOP_HEADERS.has(key)) return;
          if (key === "set-cookie") return;
          headers.set(key, value);
        });
        for (const cookie of upstream.headers.getSetCookie()) headers.append("set-cookie", cookie);
        // A redirect to the dev server's own origin stays inside the tunnel.
        const location = upstream.headers.get("location");
        if (location) {
          headers.set(
            "location",
            location.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1):${target}`), ""),
          );
        }
        return new Response(upstream.body, { status: upstream.status, headers });
      } catch {
        return new Response("The site on your computer is not answering.", { status: 502 });
      }
    },
    websocket: {
      open(ws) {
        const { upstream } = ws.data;
        upstream.onopen = () => {
          for (const message of ws.data.queue) upstream.send(message);
          ws.data.queue = [];
        };
        upstream.onmessage = (event) => {
          onTraffic();
          ws.send(event.data as string | ArrayBuffer);
        };
        upstream.onclose = () => ws.close();
        upstream.onerror = () => ws.close();
      },
      message(ws, message) {
        onTraffic();
        const { upstream } = ws.data;
        if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
        else ws.data.queue.push(message);
      },
      close(ws) {
        ws.data.upstream.close();
      },
    },
  });
  return { port: server.port ?? 0, stop: () => void server.stop(true) };
}

export type SpawnNgrok = (binary: string, args: string[]) => ChildProcess;

/** One manager per daemon. Owns every ngrok child and gate it started. */
export class TunnelManager {
  private tunnels = new Map<number, Tunnel>();
  private starting = new Map<number, Promise<TunnelInfo>>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly options: {
      binary?: () => string | undefined;
      spawnNgrok?: SpawnNgrok;
      startProxy?: typeof startGate;
      now?: () => number;
      idleMs?: number;
      startTimeoutMs?: number;
    } = {},
  ) {}

  private now() {
    return (this.options.now ?? Date.now)();
  }
  private idleMs() {
    return this.options.idleMs ?? TUNNEL_IDLE_MS;
  }

  /** Whether "Open live anywhere" is offered at all. */
  available(): boolean {
    return (this.options.binary ?? (() => findNgrok()))() !== undefined;
  }

  /** Every open tunnel, as the phone sees it. */
  list(): TunnelInfo[] {
    return [...this.tunnels.values()].map((t) => this.info(t));
  }

  private info(tunnel: Tunnel): TunnelInfo {
    return {
      port: tunnel.port,
      status: "open",
      url: `${tunnel.url}/?${TUNNEL_KEY_PARAM}=${tunnel.secret}`,
      idleCloseAt: tunnel.lastUsed + this.idleMs(),
    };
  }

  /**
   * Open (or return the already-open) tunnel for a port. `listening` is what
   * the daemon just saw; anything else is refused before ngrok is touched.
   */
  async open(
    port: number,
    listening: readonly ListeningPort[],
    notify?: (info: TunnelInfo) => void,
  ): Promise<TunnelInfo> {
    if (!listening.some((entry) => entry.port === port)) {
      throw new Error(`Nothing is listening on port ${port}`);
    }
    const existing = this.tunnels.get(port);
    if (existing) {
      existing.lastUsed = this.now();
      if (notify) existing.notify = notify;
      return this.info(existing);
    }
    const pending = this.starting.get(port);
    if (pending) return pending;
    const started = this.start(port, notify).finally(() => this.starting.delete(port));
    this.starting.set(port, started);
    return started;
  }

  private async start(port: number, notify?: (info: TunnelInfo) => void): Promise<TunnelInfo> {
    const binary = (this.options.binary ?? (() => findNgrok()))();
    if (!binary) throw new Error("ngrok is not installed on your computer.");
    const secret = randomBytes(24).toString("base64url");
    const proxy = (this.options.startProxy ?? startGate)({
      target: port,
      secret,
      onTraffic: () => {
        const open = this.tunnels.get(port);
        if (open?.secret === secret) open.lastUsed = this.now();
      },
    });
    const spawnNgrok: SpawnNgrok =
      this.options.spawnNgrok ??
      ((bin, args) => spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] }));
    let child: ChildProcess;
    try {
      child = spawnNgrok(binary, [
        "http",
        `http://127.0.0.1:${proxy.port}`,
        "--log",
        "stdout",
        "--log-format",
        "json",
        // No local inspector page on :4040: it is a website too, so Preview
        // listed ngrok's own console next to the user's sites (8 Nov).
        "--inspect=false",
      ]);
    } catch (error) {
      proxy.stop();
      throw new Error(`Could not start ngrok: ${(error as Error).message}`, { cause: error });
    }

    const url = await new Promise<string>((resolve, reject) => {
      let buffered = "";
      let problems = "";
      let settled = false;
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          killChild(child);
          proxy.stop();
          reject(error);
        } else resolve(value!);
      };
      const timer = setTimeout(
        () =>
          finish(new Error(problems ? ngrokError(problems) : "ngrok did not start within 20s.")),
        this.options.startTimeoutMs ?? START_TIMEOUT_MS,
      );
      const read = (chunk: Buffer | string) => {
        buffered += chunk.toString();
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          let record: Record<string, unknown>;
          try {
            record = JSON.parse(line) as Record<string, unknown>;
          } catch {
            if (line.includes("ERR_NGROK") || /error/i.test(line)) problems += `${line}\n`;
            continue;
          }
          if (typeof record.url === "string" && record.url.startsWith("https://")) {
            finish(undefined, record.url);
          } else if (record.lvl === "eror" || record.lvl === "crit") {
            const err =
              typeof record.err === "string"
                ? record.err
                : typeof record.msg === "string"
                  ? record.msg
                  : "";
            problems += `${err}\n`;
            // A refused session is final; ngrok would only retry and fail again.
            if (/ERR_NGROK_\d+/.test(err)) finish(new Error(ngrokError(err)));
          }
        }
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      child.on("error", (error) =>
        finish(
          new Error(
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "ngrok is not installed on your computer."
              : `Could not start ngrok: ${error.message}`,
          ),
        ),
      );
      child.on("exit", () => finish(new Error(ngrokError(problems))));
    });

    const tunnel: Tunnel = { port, secret, url, child, proxy, lastUsed: this.now(), notify };
    this.tunnels.set(port, tunnel);
    const opened = tunnel;
    // ngrok dying on its own (killed, crashed, its session ended) closes the
    // tunnel here too, and the phone is told rather than left with a dead link.
    child.on("exit", () => {
      if (this.tunnels.get(port) !== opened) return;
      this.tunnels.delete(port);
      opened.proxy.stop();
      opened.notify?.({ port, status: "closed", message: "The link closed on your computer." });
    });
    this.ensureSweep();
    console.log(`[tunnel] port ${port} open via ngrok (pid ${child.pid})`);
    return this.info(tunnel);
  }

  /** Close one port's tunnel. Closing one that is not open is not an error. */
  close(port: number, reason?: string): TunnelInfo {
    const tunnel = this.tunnels.get(port);
    const info: TunnelInfo = { port, status: "closed", ...(reason ? { message: reason } : {}) };
    if (!tunnel) return info;
    this.tunnels.delete(port);
    killChild(tunnel.child);
    tunnel.proxy.stop();
    console.log(`[tunnel] port ${port} closed${reason ? `: ${reason}` : ""}`);
    if (this.tunnels.size === 0) this.stopSweep();
    return info;
  }

  /** Close everything idle past the limit, telling whoever opened it. */
  sweep(): void {
    const now = this.now();
    for (const tunnel of [...this.tunnels.values()]) {
      if (now - tunnel.lastUsed >= this.idleMs()) {
        const info = this.close(tunnel.port, "Closed after 30 minutes without use.");
        tunnel.notify?.(info);
      }
    }
  }

  /** Daemon shutdown: every ngrok child goes with it. */
  closeAll(): void {
    for (const port of [...this.tunnels.keys()]) this.close(port);
    this.stopSweep();
  }

  /** PIDs of running ngrok children, for the exit hook and tests. */
  pids(): number[] {
    return [...this.tunnels.values()].flatMap((t) => (t.child.pid ? [t.child.pid] : []));
  }

  private ensureSweep() {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
  }
  private stopSweep() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** By its own PID, never by name: other ngrok sessions on this Mac are not ours. */
function killChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
}

/** The daemon's one manager. */
export const tunnels = new TunnelManager();

// A daemon that exits without `closeAll` (a crash, an uncaught error) still
// takes its ngrok children with it. Synchronous, as an exit hook must be.
process.on("exit", () => {
  for (const pid of tunnels.pids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});
