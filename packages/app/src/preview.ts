/**
 * Reaching a dev server that is running on the desktop, from the phone.
 *
 * Pure and Expo-free: the binding to the in-app browser and to the daemon
 * socket lives in `ui/PreviewSheet.tsx` and `MarkdownText.tsx`.
 *
 * `localhost` in a transcript is the desktop's loopback. Here it is dead. The
 * daemon reports the addresses the desktop answers on from its own network,
 * and every local link or server is re-addressed to the first of those. Off
 * that network the page cannot be opened at all — only rendered by the daemon
 * and shipped as a picture — which is the snapshot half, and that needs no URL.
 */

/** A listener the daemon reported. Mirrors `wire.PreviewServer`. */
export interface PreviewServer {
  port: number;
  process: string;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/i;

/**
 * `http://<lan host>:<port><path>`, or nothing when the desktop reported no
 * LAN address — the case a laptop on cellular tethering hits, where there is
 * no reachable page and the button should not exist.
 */
export function previewUrl(
  lanHosts: readonly string[],
  port: number,
  path = "/",
): string | undefined {
  const host = lanHosts[0];
  if (!host) return undefined;
  return `http://${formatHost(host)}:${port}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * A `localhost` / `127.0.0.1` link re-addressed to the desktop's LAN host.
 *
 * Anything else — a public site, an already-LAN address — comes back
 * untouched, and so does a local link when no host is known: opening it will
 * fail, but silently swallowing the tap is worse than a failed page.
 */
export function rewriteLocalhost(url: string, lanHosts: readonly string[]): string {
  const host = lanHosts[0];
  if (!host) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
  if (!LOOPBACK.test(parsed.hostname)) return url;
  parsed.hostname = formatHost(host);
  return parsed.toString();
}

/**
 * Where a rendered snapshot of a port lands in the image cache.
 *
 * Exactly the `uri` the daemon echoes in its `image` reply for a snapshot
 * (`handler.ts`, `preview.snapshot`), so the reply files itself under the same
 * entry the sheet is watching.
 */
export function previewImageKey(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

/** An IPv6 address has to be bracketed inside a URL authority. */
function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Sort servers so the one most likely to be "the site" comes first: known dev
 * server ports before the rest, then by port. The list is every listener the
 * user owns, and the noise (language servers, databases) usually sits high.
 */
const DEV_PORTS = new Set([3000, 3001, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8081, 8787]);

export function rankServers(servers: readonly PreviewServer[]): PreviewServer[] {
  return [...servers].sort((a, b) => {
    const aDev = DEV_PORTS.has(a.port) ? 0 : 1;
    const bDev = DEV_PORTS.has(b.port) ? 0 : 1;
    return aDev - bDev || a.port - b.port;
  });
}

/**
 * One port's "Open live anywhere" link, as the sheet tracks it. `starting` and
 * `closing` are the phone's own states while it waits; the rest come from the
 * daemon's `preview.tunnel.state`. Mirrors `wire.PreviewTunnelState`.
 */
export interface TunnelEntry {
  status: "starting" | "closing" | "open" | "closed" | "error";
  /** First-visit address; carries the secret, so never shown on screen. */
  url?: string;
  /** Epoch ms it closes at if unused until then. */
  idleCloseAt?: number;
  message?: string;
}

export type TunnelMap = Record<number, TunnelEntry>;

/** What the daemon said about one port's link. */
export interface TunnelUpdate {
  port: number;
  status: "open" | "closed" | "error";
  url?: string;
  idleCloseAt?: number;
  message?: string;
}

/** Fold a daemon update into the map. A plain close is forgotten; a close with a reason is kept to show it. */
export function applyTunnelUpdate(map: TunnelMap | undefined, update: TunnelUpdate): TunnelMap {
  const next: TunnelMap = { ...map };
  if (update.status === "closed" && !update.message) {
    delete next[update.port];
    return next;
  }
  next[update.port] = {
    status: update.status,
    ...(update.url ? { url: update.url } : {}),
    ...(update.idleCloseAt ? { idleCloseAt: update.idleCloseAt } : {}),
    ...(update.message ? { message: update.message } : {}),
  };
  return next;
}

/**
 * The map after a fresh `preview.servers`: the daemon's open links win, and a
 * request still in flight on the phone is kept, since its answer is coming.
 */
export function mergeTunnelList(
  previous: TunnelMap | undefined,
  open: readonly TunnelUpdate[] | undefined,
): TunnelMap {
  const next: TunnelMap = {};
  for (const [port, entry] of Object.entries(previous ?? {})) {
    if (entry.status === "starting" || entry.status === "closing") next[Number(port)] = entry;
  }
  for (const update of open ?? []) {
    if (update.status === "open") Object.assign(next, applyTunnelUpdate(next, update));
  }
  return next;
}

/** "14:05", the clock time a link closes, in the phone's own locale. */
function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** How the sheet shows one port's link: the button's label and the line under it. */
export interface TunnelView {
  label: string;
  /** Waiting on the computer: the button is disabled and shows a spinner. */
  busy: boolean;
  /** A link is open and can be closed. */
  closable: boolean;
  note?: string;
}

export function tunnelView(entry: TunnelEntry | undefined): TunnelView {
  switch (entry?.status) {
    case "starting":
      return { label: "Starting…", busy: true, closable: false, note: "Opening a private link…" };
    case "closing":
      return { label: "Closing…", busy: true, closable: false };
    case "open":
      return {
        label: "Open anywhere",
        busy: false,
        closable: true,
        note: entry.idleCloseAt
          ? `Private link open. Closes at ${clock(entry.idleCloseAt)} if unused.`
          : "Private link open.",
      };
    case "error":
    case "closed":
      return { label: "Open anywhere", busy: false, closable: false, note: entry.message };
    default:
      return { label: "Open anywhere", busy: false, closable: false };
  }
}
