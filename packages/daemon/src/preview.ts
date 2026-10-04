/**
 * Seeing a site the agent is running, from a phone that cannot reach it.
 *
 * `http://localhost:3000` in a transcript names the *desktop's* loopback; on
 * the phone it is a dead link. Two things only this machine can answer:
 *
 * - which ports something is listening on, so the app can open the page over
 *   the LAN (a real, live page with hot reload) when it shares the network;
 * - what that page looks like, rendered here by headless Chrome at phone width
 *   and shipped as a picture, for when it does not.
 *
 * The snapshot takes a *port*, never a URL. The host is always `127.0.0.1` and
 * the port must be one this module itself just saw listening, so a stolen
 * pairing token cannot turn the daemon into a fetch-anything proxy sitting
 * inside the user's network.
 */
import { execFile, spawn } from "node:child_process";
import { access, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { loadImage, type LoadedImage } from "./images.js";
import { findOnPath, userProvidersDir } from "./providers/registry.js";

const run = promisify(execFile);

export interface ListeningPort {
  port: number;
  /** Command name of the listening process, as the OS reports it. */
  process: string;
}

/** Below this is the system's range; a dev server never lives there. */
const FIRST_USER_PORT = 1024;

/**
 * Parse `lsof -iTCP -sTCP:LISTEN -P -n -Fcn` (macOS, BSD).
 *
 * Field output, one prefixed value per line: `p<pid>`, then `c<command>`, then
 * a `n<name>` per socket. Only the port at the end of the name is read: the
 * address before it is `*`, `127.0.0.1` or `[::1]`, and none of them change
 * whether the page can be rendered from here.
 */
export function parseLsof(output: string): ListeningPort[] {
  const found = new Map<number, string>();
  let command = "";
  for (const line of output.split("\n")) {
    const tag = line[0];
    const value = line.slice(1).trim();
    if (tag === "c") command = value;
    else if (tag === "n") {
      const port = Number(/:(\d+)$/.exec(value)?.[1]);
      if (port >= FIRST_USER_PORT && !found.has(port)) found.set(port, command);
    }
  }
  return [...found].map(([port, process]) => ({ port, process })).sort((a, b) => a.port - b.port);
}

/**
 * Parse `ss -ltnpH` (Linux).
 *
 * One socket per line; the local address is the fourth column and the owning
 * process, when readable, sits in `users:(("node",pid=1,fd=2))` at the end.
 */
export function parseSs(output: string): ListeningPort[] {
  const found = new Map<number, string>();
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4) continue;
    const port = Number(/:(\d+)$/.exec(columns[3]!)?.[1]);
    if (!(port >= FIRST_USER_PORT) || found.has(port)) continue;
    found.set(port, /users:\(\("([^"]+)"/.exec(line)?.[1] ?? "");
  }
  return [...found].map(([port, process]) => ({ port, process })).sort((a, b) => a.port - b.port);
}

/**
 * Every port this user has something listening on.
 *
 * Never throws: no `lsof`, no permission, or a platform with neither tool is
 * "no servers", which the app shows as no preview button.
 *
 * simplification: lists every listener the user owns (an editor's language
 * server, a database) rather than only the session's own child tree. Walking
 * `children.json` pids into their descendants is the upgrade when the list
 * gets noisy.
 */
export async function listeningPorts(
  platform: NodeJS.Platform = process.platform,
  exec: typeof run = run,
): Promise<ListeningPort[]> {
  const options = { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 };
  try {
    if (platform === "linux") {
      const { stdout } = await exec("ss", ["-ltnpH"], options);
      return parseSs(stdout);
    }
    if (platform === "win32") return [];
    const { stdout } = await exec("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-Fcn"], options);
    return parseLsof(stdout);
  } catch (error) {
    // lsof exits 1 when it finds nothing at all; that is an empty list, and so
    // is any other failure here.
    const stdout = (error as { stdout?: string }).stdout;
    return typeof stdout === "string" && platform !== "linux" ? parseLsof(stdout) : [];
  }
}

/**
 * A path the client may ask for on the local server: absolute, one segment
 * chain, no authority. `//evil.example` would be read by the browser as a new
 * host, which is exactly the fetch-anything hole the port-only design closes.
 */
export function validatePreviewPath(path: string | undefined): string {
  if (path === undefined || path === "") return "/";
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
    throw new Error("Preview path must start with a single '/'");
  }
  if (/[\s\0]/.test(path) || path.split(/[?#]/)[0]!.split("/").includes("..")) {
    throw new Error("Preview path may not climb or contain whitespace");
  }
  return path;
}

/** Where headless Chrome lives when it is not on PATH. */
const CHROME_LOCATIONS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

/** The first Chromium-family browser installed here, or nothing. */
export function chromeBinary(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.PEW2_CHROME) return env.PEW2_CHROME;
  for (const candidate of CHROME_LOCATIONS[platform] ?? []) {
    const found = findOnPath(candidate, env);
    if (found) return found;
  }
  return undefined;
}

/** A full-length page is capped here; base64 of a taller one crowds the frame. */
const MAX_HEIGHT = 4_000;
const DEFAULT_WIDTH = 390;
/** Chrome's first cold launch is 2–4s; a page that never settles is cut here. */
const SNAPSHOT_TIMEOUT_MS = 15_000;

export interface SnapshotOptions {
  port: number;
  path?: string;
  width?: number;
  /** Which ports may be rendered: the answer to `listeningPorts()`, taken now. */
  listening: ListeningPort[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * Render `http://127.0.0.1:<port><path>` and return it as a data URI.
 *
 * Chrome is asked to screenshot to a file in the temp directory and is then
 * killed: `--headless=new` on macOS writes the picture within a couple of
 * seconds and then never exits on its own, so "bytes written to file" on its
 * stderr is the completion signal (file existence alone is not: it would be
 * read half-written). The file is read back through `loadImage`, which is what
 * already bounds the size and confines the path, and unlinked either way.
 */
export async function snapshot(options: SnapshotOptions): Promise<LoadedImage> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (!options.listening.some((entry) => entry.port === options.port)) {
    throw new Error(`Nothing is listening on port ${options.port}`);
  }
  const path = validatePreviewPath(options.path);
  const chrome = chromeBinary(platform, env);
  if (!chrome) throw new Error("Install Google Chrome on this computer for remote preview");

  const width = Math.min(Math.max(options.width ?? DEFAULT_WIDTH, 320), 1_600);
  const dir = tmpdir();
  const file = join(dir, `pew2-preview-${process.pid}-${Date.now()}.png`);
  const url = `http://127.0.0.1:${options.port}${path}`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      chrome,
      [
        "--headless=new",
        `--screenshot=${file}`,
        `--window-size=${width},${MAX_HEIGHT}`,
        "--hide-scrollbars",
        "--no-first-run",
        "--disable-gpu",
        // Its own profile, or a running desktop Chrome refuses the second
        // instance and the request never produces a file. Under `~/.pew2`, not
        // the temp dir: Chrome binds a Unix socket inside it, and macOS caps a
        // socket path at 104 bytes — `$TMPDIR` alone is 50 of them, and the
        // failure is silent, no file and no log line.
        `--user-data-dir=${join(dirname(userProvidersDir(env)), "cache", "chrome")}`,
        url,
      ],
      { stdio: ["ignore", "ignore", "pipe"], env },
    );
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Chrome's helpers watch the browser process and follow it down.
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`Page on port ${options.port} did not render within 15s`)),
      SNAPSHOT_TIMEOUT_MS,
    );
    child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("written to file")) finish();
    });
    child.on("error", (error) => finish(new Error(`Could not start Chrome: ${error.message}`)));
    child.on("exit", () => {
      access(file).then(
        () => finish(),
        () => finish(new Error(`Chrome exited without rendering port ${options.port}`)),
      );
    });
  });

  try {
    return await loadImage(file, { cwd: dir, env });
  } finally {
    await unlink(file).catch(() => undefined);
  }
}
