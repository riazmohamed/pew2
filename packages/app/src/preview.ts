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
