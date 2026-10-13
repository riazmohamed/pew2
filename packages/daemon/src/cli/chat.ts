/**
 * `pew2 chat`: a terminal window onto the same daemon session the phone shows.
 *
 * Not a second agent. It is one more client of the running daemon, exactly like
 * the phone: it follows whichever conversation saw the latest activity, streams
 * it, mirrors the half-typed draft both ways, and prompts the same session.
 * Sockets, raw mode and drawing live here; the decisions live in `chat-core.ts`.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir, hostname, tmpdir } from "node:os";
import { SecureChannel, e2e, wire } from "@pew2/protocol";
import { loadPairing } from "../pairing.js";
import { daemonPort, daemonUrl } from "./doctor.js";
import { isCompiled } from "./service.js";
import { HERE_FLAG, openWindowScript, pickTerminal, windowCommand } from "./chat-window.js";
import {
  DraftThrottle,
  Follow,
  applyInput,
  backoffMs,
  chatDeviceId,
  chatSocketUrl,
  draftApplies,
  draftIsActivity,
  permissionView,
  pickAgent,
  providerFromSessionId,
  renderEvents,
  rowsFor,
  type Rendered,
} from "./chat-core.js";
import {
  THEME,
  bannerLines,
  colorMode,
  diffLines,
  footerLines,
  painter,
  promptLine,
  ruleLine,
  slashMenuLines,
  toolLine,
  toolResultLine,
  userMessageLines,
  visibleWidth,
} from "./chat-theme.js";
import { MarkdownStream } from "./chat-markdown.js";
import {
  CATEGORY_FOR_COMMAND,
  LOCAL_COMMANDS,
  agentCommandList,
  completeSlash,
  currentLabel,
  findOption,
  helpLines,
  listOption,
  pickOptionValue,
  readAgentCommands,
  routeSlash,
  slashMatches,
  type CommandInfo,
  type ConfigOptionLike,
} from "./chat-commands.js";
import {
  attachmentsError,
  buildAttachment,
  imageMimeForPath,
  needsDownscale,
  osc1337,
  parseAttachArgs,
  parseDataUri,
  screenshotName,
  supportsInlineImages,
  type Attachment,
  type ChatImage,
} from "./chat-images.js";
// Imported rather than read from disk: a compiled binary has no package.json.
import pkg from "../../package.json" with { type: "json" };

const paint = painter(colorMode(process.env));
const dim = (text: string) => paint.dim(text);
const red = (text: string) => paint.fg(THEME.error, text);
const yellow = (text: string) => paint.fg(THEME.warning, text);

/** Rendered events kept per session, for `/switch`. */
const HISTORY_CAP = 2000;
/** How much of a conversation to show on joining or switching. */
const SHOW_RECENT = 60;

/**
 * The live area at the bottom of the window, drawn like OG Coder's composer:
 * a rule, the `> ` prompt, a rule, the slash menu while a command is typed,
 * and the footer. Output scrolls above it; it is redrawn in place. A reply
 * still streaming shows its unfinished line just above the input.
 */
class Screen {
  private partial = "";
  /** Rows the live area occupies, and how many of them sit below the cursor. */
  private rows = 0;
  private below = 0;
  input = "";
  /** Footer rows, read fresh on every redraw. */
  footerOf: (columns: number) => string[] = () => [];
  /** Menu rows under the input, e.g. matching slash commands. */
  menuOf: (columns: number) => string[] = () => [];

  constructor(private readonly out: NodeJS.WriteStream) {}

  columns() {
    return Math.max(20, this.out.columns ?? 80);
  }

  private clear() {
    if (this.rows === 0) return;
    // Up from the cursor's row to the top of the live area, then wipe down.
    const up = this.rows - 1 - this.below;
    this.out.write(`\r${up > 0 ? `\x1b[${up}A` : ""}\x1b[J`);
    this.rows = 0;
    this.below = 0;
  }

  private draw() {
    const columns = this.columns();
    const prompt = promptLine(this.input, paint);
    const head = `${this.partial ? `${this.partial}\n` : ""}${ruleLine(paint, columns)}\n${prompt}`;
    const tail = [ruleLine(paint, columns), ...this.menuOf(columns), ...this.footerOf(columns)].join("\n");
    this.out.write(`${head}\n${tail}`);
    const tailRows = rowsFor(tail, columns);
    this.rows = rowsFor(head, columns) + tailRows;
    // Back up into the prompt, so the terminal's cursor sits where typing goes.
    const promptRows = rowsFor(prompt, columns);
    const col = visibleWidth(prompt) - (promptRows - 1) * columns;
    this.out.write(`\x1b[${tailRows}A\r${col > 0 ? `\x1b[${col}C` : ""}`);
    this.below = tailRows;
  }

  /** Whole lines of output, above the live area. */
  print(line: string) {
    this.clear();
    this.out.write(`${line}\n`);
    this.draw();
  }

  /** The unfinished line of a streaming reply, or "" when none. */
  setPartial(text: string) {
    if (text === this.partial) return;
    this.clear();
    this.partial = text;
    this.draw();
  }

  setInput(text: string) {
    this.clear();
    this.input = text;
    this.draw();
  }

  /** Redraw as is (the footer changed). */
  refresh() {
    this.clear();
    this.draw();
  }

  /** Leave the terminal tidy. */
  close() {
    this.clear();
    if (this.partial) this.out.write(`${this.partial}\n`);
    this.partial = "";
  }
}

interface ProviderRow {
  id: string;
  name: string;
  available: boolean;
}

function parseArgs(argv: string[]): {
  session?: string;
  focus?: string;
  agent?: string;
  project?: string;
  all: boolean;
  help: boolean;
} {
  const out: { session?: string; focus?: string; agent?: string; project?: string; all: boolean; help: boolean } = {
    help: false,
    all: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--session") out.session = argv[++i];
    else if (arg.startsWith("--session=")) out.session = arg.slice(10);
    else if (arg === "--agent") out.agent = argv[++i];
    else if (arg.startsWith("--agent=")) out.agent = arg.slice(8);
    else if (arg === "--project") out.project = argv[++i];
    else if (arg.startsWith("--project=")) out.project = arg.slice(10);
    else if (arg === "--all") out.all = true;
    else if (arg === "--focus") out.focus = argv[++i];
    else if (arg.startsWith("--focus=")) out.focus = arg.slice(8);
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

const HELP = [
  "Type and press Enter to send to the conversation shown. The phone sees every keystroke.",
  ...LOCAL_COMMANDS.filter((c) => c.name !== "exit").map(
    (c) => `  ${`/${c.name}${c.hint ? ` ${c.hint}` : ""}`.padEnd(26)} ${c.description}`,
  ),
  "  The agent's own slash commands work too; /help lists them. A number answers a permission request.",
];

const KEYS = "Enter send · Tab complete · /help · Esc or Ctrl-C quit";
const DEFAULT_SHOT_TEXT = "Here's a screenshot of my screen.";

/** `~`-shortened, as OG Coder's banner shows paths. */
function displayPath(path: string): string {
  const home = homedir();
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * Take a screenshot of this Mac (or a dragged region) and read it back,
 * downscaled when big, with the temp file always removed.
 */
async function captureScreen(area: boolean): Promise<{ bytes: Uint8Array } | { error: string }> {
  if (process.platform !== "darwin") return { error: "screenshots need macOS (screencapture)" };
  const dir = mkdtempSync(join(tmpdir(), "pew2-shot-"));
  const file = join(dir, "shot.png");
  try {
    const shot = Bun.spawn(["/usr/bin/screencapture", "-x", ...(area ? ["-i"] : []), "-t", "png", file], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const code = await shot.exited;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      size = 0;
    }
    if (size === 0) {
      if (area) return { error: "screenshot cancelled" };
      const detail = (await new Response(shot.stderr).text()).trim();
      return { error: `screencapture failed${code ? ` (${code})` : ""}${detail ? `: ${detail}` : ""}` };
    }
    const probe = Bun.spawnSync(["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", file], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const dims = [...probe.stdout.toString().matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map((m) => Number(m[1]));
    if (needsDownscale(size, Math.max(0, ...dims))) {
      Bun.spawnSync(["/usr/bin/sips", "-Z", "1800", file], { stdout: "ignore", stderr: "ignore" });
    }
    return { bytes: new Uint8Array(readFileSync(file)) };
  } catch (error) {
    return { error: `screenshot failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function daemonUp(): Promise<boolean> {
  try {
    const response = await fetch(`${daemonUrl()}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The project this window belongs to: `--project`, else the git repository the
 * command was run from. Undefined (follow everything) outside any repository or
 * with `--all`. Real paths, because that is what the daemon publishes.
 */
function resolveProject(args: { project?: string; all: boolean }): string | undefined {
  if (args.all) return undefined;
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  if (args.project) return real(resolve(args.project));
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "ignore",
    });
    const top = result.exitCode === 0 ? result.stdout.toString().trim() : "";
    return top ? real(top) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Open the chat in a window of its own (macOS), leaving this shell alone.
 * False when that is not possible here, and the caller runs inline instead.
 */
async function openOwnWindow(argv: string[]): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const command = windowCommand({
    execPath: process.execPath,
    script: process.argv[1],
    compiled: isCompiled(),
    args: argv,
    env: process.env,
  });
  const app = pickTerminal(process.env);
  try {
    const child = Bun.spawn(["/usr/bin/osascript", "-e", openWindowScript(app, command)], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const code = await child.exited;
    if (code !== 0) {
      const detail = (await new Response(child.stderr).text()).trim();
      console.error(`Could not open a new window${detail ? ` (${detail})` : ""}. Running here instead.`);
      return false;
    }
    console.log(`pew2 chat opened in a new ${app === "iterm" ? "iTerm" : "Terminal"} window.`);
    return true;
  } catch {
    return false;
  }
}

export async function cmdChat(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("pew2 chat [--project <dir> | --all] [--agent <id>] [--session <id>] [--here]\n");
    console.log("Opens in a new window of its own; --here runs it in this terminal instead.");
    console.log("Run inside a project and the window belongs to that project: it follows only");
    console.log("that project's conversations and starts new ones there. --all follows every project.\n");
    for (const line of HELP) console.log(line);
    return 0;
  }
  const project = resolveProject(args);
  if (!argv.includes(HERE_FLAG)) {
    if (!(await daemonUp())) {
      console.error(
        `The pew2 daemon isn't running on port ${daemonPort()}. Start it with \`pew2 service install\` or \`pew2 serve\`.`,
      );
      return 1;
    }
    // The new window starts in the home folder, so the project goes with it.
    const forwarded = project && !args.project && !args.all ? [...argv, "--project", project] : argv;
    if (await openOwnWindow(forwarded)) return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("pew2 chat needs an interactive terminal (stdin and stdout must be a TTY).");
    return 1;
  }
  const port = daemonPort();
  if (!(await daemonUp())) {
    console.error(
      `The pew2 daemon isn't running on port ${port}. Start it with \`pew2 service install\` or \`pew2 serve\`.`,
    );
    return 1;
  }
  const pairing = await loadPairing();
  if (!pairing.key) {
    console.error("This pairing has no encryption key. Run `pew2 pair --rotate`.");
    return 1;
  }
  const rootKey = e2e.fromHex(pairing.key);
  const url = chatSocketUrl(port, pairing.token);
  const ownId = chatDeviceId(hostname(), randomBytes(3).toString("hex"));

  const screen = new Screen(process.stdout);
  const follow = new Follow(args.session, project);
  const projectName = project ? basename(project) : undefined;
  const inlineImages = supportsInlineImages(process.env);
  // The window's title, so several project windows can be told apart.
  process.stdout.write(`\x1b]0;pew2 · ${projectName ?? "all projects"}\x07`);
  const cursors: Record<string, number> = {};
  const history = new Map<string, Rendered[]>();
  const permissions = new Map<string, Map<string, Extract<Rendered, { kind: "permission" }>>>();
  // Selectors and agent commands: per live session, and per provider for a
  // conversation not started yet (or one whose own set has not arrived).
  const sessionConfig = new Map<string, ConfigOptionLike[]>();
  const providerConfig = new Map<string, ConfigOptionLike[]>();
  const sessionCommands = new Map<string, CommandInfo[]>();
  const providerCommands = new Map<string, CommandInfo[]>();
  const capabilitiesAsked = new Set<string>();
  // Pictures fetched from the daemon, per uri, and the fetches in flight.
  const imageCache = new Map<string, { dataUri?: string; error?: string }>();
  const imageRequests = new Map<string, { image: ChatImage; sessionId: string }>();
  const shownDiffs = new Set<string>();
  let providers: ProviderRow[] = [];
  let active: string[] = [];
  let keepAwake: { supported: boolean; enabled: boolean; active: boolean; reason?: string } | undefined;
  let draftsSupported = false;
  let lastAgent: string | undefined;
  let pendingStart: { requestId: string; text: string; attachments: Attachment[] } | undefined;
  // A new conversation waiting on the daemon to accept this window's project:
  // it honours a client-named cwd only once it has published that path itself,
  // which browsing to it does. Same rule the phone lives by.
  let pendingProject: { requestId: string; text: string; agent: string; attachments: Attachment[] } | undefined;
  // A conversation reopened because the daemon restarted under it (an update,
  // a reboot). Keyed by the agent's id, which is all that survives.
  let pendingResume: { agentSessionId: string; text: string; attachments: Attachment[] } | undefined;
  let socket: WebSocket | undefined;
  let channel: SecureChannel | undefined;
  let joined = false;
  let everJoined = false;
  let hydrated = false;
  let attempt = 0;
  let reconnecting = false;
  let quitting = false;
  let replays: { sessionId: string; events: { seq: number; at: number; payload: unknown }[]; permissions?: { requestId: string; params: unknown }[] }[] = [];
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => (resolveExit = resolve));

  const send = (message: unknown): boolean => {
    if (!socket || !channel || !joined || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(channel.seal(message)));
    return true;
  };

  const throttle = new DraftThrottle((key, text) => {
    if (!draftsSupported) return;
    // The mirror rule of the inbound one: an unstarted conversation's draft
    // names no project, so a project window keeps its own to itself.
    if (key === "" && project !== undefined) return;
    send({ t: "session.draft", ...(key !== "" && { sessionId: key }), text });
  });

  const agentName = (id?: string) => providers.find((p) => p.id === id)?.name ?? id ?? "conversation";

  /** The agent behind a conversation key ("" is the next new one). */
  const providerOf = (key: string): string | undefined => {
    if (key === "") return pickAgent(args.agent, lastAgent, providers);
    const meta = follow.meta(key);
    meta.providerId ??= providerFromSessionId(key, providers);
    return meta.providerId;
  };

  const describe = (key: string): string => {
    if (key === "") {
      return `new conversation · ${agentName(providerOf(""))}${projectName ? ` · ${projectName}` : ""}`;
    }
    const meta = follow.meta(key);
    const where = meta.folder ?? meta.cwd?.split(/[\\/]/).filter(Boolean).pop();
    return `${agentName(providerOf(key))}${where ? ` · ${where}` : ""}${active.includes(key) ? "" : " (closed)"}`;
  };

  /** The selectors that apply to what Enter goes to now. */
  const currentOptions = (): ConfigOptionLike[] => {
    const key = follow.current;
    const own = key ? sessionConfig.get(key) : undefined;
    if (own && own.length > 0) return own;
    const provider = providerOf(key);
    return (provider && providerConfig.get(provider)) || [];
  };

  const currentCommands = (): CommandInfo[] => {
    const key = follow.current;
    const own = key ? sessionCommands.get(key) : undefined;
    if (own) return own;
    const provider = providerOf(key);
    return (provider && providerCommands.get(provider)) || [];
  };

  /** Ask once per provider what it offers, for selectors and commands not yet known. */
  const askCapabilities = (key: string) => {
    const provider = providerOf(key);
    if (!provider || capabilitiesAsked.has(provider)) return;
    if (key && sessionConfig.get(key)?.length && sessionCommands.has(key)) return;
    if (send({ t: "provider.capabilities", providerId: provider })) capabilitiesAsked.add(provider);
  };

  // The footer names what Enter goes to, the model and thinking level, and the keys.
  screen.footerOf = (columns) => {
    const options = currentOptions();
    return footerLines(
      {
        status: `→ ${describe(follow.current)}`,
        model: currentLabel(findOption(options, "model")),
        thinking: currentLabel(findOption(options, "thought_level")),
        mode: currentLabel(findOption(options, "mode")),
        keys: KEYS,
      },
      paint,
      columns,
    );
  };
  screen.menuOf = (columns) => {
    if (!/^\/[\w:.-]*$/.test(screen.input)) return [];
    const matches = slashMatches(screen.input, currentCommands());
    return matches.length > 0 ? slashMenuLines(matches, paint, columns) : [];
  };

  // The reply streaming in the followed conversation, drawn as markdown.
  let reply: MarkdownStream | undefined;

  const drawImage = (image: ChatImage, dataUri: string) => {
    const parsed = parseDataUri(dataUri);
    if (!parsed) {
      screen.print(dim(`   [image: ${image.name}]`));
      return;
    }
    screen.print(osc1337(parsed.base64, image.name, screen.columns()));
  };

  const showImage = (image: ChatImage, sessionId: string) => {
    if (!inlineImages) {
      screen.print(dim(`   [image: ${image.name}]`));
      return;
    }
    if (image.src.startsWith("data:")) {
      drawImage(image, image.src);
      return;
    }
    const cached = imageCache.get(image.src);
    if (cached?.dataUri) {
      drawImage(image, cached.dataUri);
      return;
    }
    if (cached?.error) {
      screen.print(dim(`   [image: ${image.name}] ${cached.error}`));
      return;
    }
    if ([...imageRequests.values()].some((r) => r.image.src === image.src)) return;
    const requestId = `chat-img-${randomBytes(4).toString("hex")}`;
    if (send({ t: "image.fetch", requestId, ...(sessionId && { sessionId }), uri: image.src })) {
      imageRequests.set(requestId, { image, sessionId });
    } else {
      screen.print(dim(`   [image: ${image.name}]`));
    }
  };

  const emitReply = (outs: ReturnType<MarkdownStream["feed"]>, sessionId: string) => {
    for (const out of outs) {
      if (out.kind === "line") screen.print(out.text);
      else showImage({ src: out.src, name: out.alt }, sessionId);
    }
  };

  /** Finish the streaming reply, if any, before anything else is drawn. */
  const endReply = (sessionId = follow.current) => {
    if (!reply) return;
    const outs = reply.flush();
    reply = undefined;
    screen.setPartial("");
    emitReply(outs, sessionId);
  };

  const divider = (key: string) => {
    endReply();
    screen.print("");
    screen.print(`${paint.fg(THEME.border, "──── ")}${paint.bold(describe(key))}${paint.fg(THEME.border, " ────")}`);
    const meta = key ? follow.meta(key) : undefined;
    if (key && !meta?.cwd && !meta?.folder) send({ t: "workspace.status", sessionId: key });
    askCapabilities(key);
  };

  const show = (item: Rendered, sessionId: string) => {
    if (item.kind === "text") {
      reply ??= new MarkdownStream(paint, () => screen.columns());
      emitReply(reply.feed(item.text), sessionId);
      screen.setPartial(reply?.preview() ?? "");
      return;
    }
    endReply(sessionId);
    switch (item.kind) {
      case "user":
        screen.print("");
        for (const line of userMessageLines(item.text, paint, screen.columns(), item.images ?? 0)) screen.print(line);
        screen.print("");
        return;
      case "tool":
        screen.print(toolLine(item.text, paint, screen.columns(), item.status));
        return;
      case "toolResult":
        if (item.diff) {
          const key = `${item.id ?? ""}:${item.diff.path}:${item.diff.added.length}:${item.diff.removed.length}`;
          if (shownDiffs.has(key)) return;
          shownDiffs.add(key);
          for (const line of diffLines(item.diff, paint, screen.columns())) screen.print(line);
        } else if (item.status === "failed") {
          screen.print(toolResultLine("failed", paint, THEME.error));
        }
        return;
      case "image":
        showImage(item.image, sessionId);
        return;
      case "exit":
        screen.print(dim(`  ${item.text}`));
        return;
      case "permission":
        screen.print(yellow(`? ${item.title}`));
        item.options.forEach((option, i) => screen.print(yellow(`  ${i + 1}. ${option.name}`)));
        screen.print(dim("  type a number and Enter to answer"));
    }
  };

  const remember = (sessionId: string, item: Rendered) => {
    const list = history.get(sessionId) ?? [];
    list.push(item);
    if (list.length > HISTORY_CAP) list.splice(0, list.length - HISTORY_CAP);
    history.set(sessionId, list);
    if (item.kind === "permission") {
      const open = permissions.get(sessionId) ?? new Map();
      open.set(item.requestId, item);
      permissions.set(sessionId, open);
    }
  };

  const showRecent = (sessionId: string) => {
    const list = history.get(sessionId) ?? [];
    shownDiffs.clear();
    for (const item of list.slice(-SHOW_RECENT)) if (item.kind !== "permission") show(item, sessionId);
    endReply(sessionId);
    for (const open of permissions.get(sessionId)?.values() ?? []) show(open, sessionId);
  };

  const ingest = (sessionId: string, event: { seq: number; at: number; payload: unknown }, live: boolean) => {
    if (event.seq <= (cursors[sessionId] ?? -1)) return;
    cursors[sessionId] = event.seq;
    const commands = readAgentCommands(event.payload);
    if (commands) {
      sessionCommands.set(sessionId, commands);
      if (live && sessionId === follow.current) screen.refresh();
    }
    const items = renderEvents(event.payload);
    if (items.length === 0) return;
    for (const item of items) remember(sessionId, item);
    if (!live) return;
    if (follow.activity(sessionId, event.at)) divider(sessionId);
    if (follow.current === sessionId) for (const item of items) show(item, sessionId);
  };

  const statusLine = () => {
    const awake = !keepAwake
      ? "keep-awake: n/a (older daemon)"
      : !keepAwake.supported
        ? `keep-awake: unsupported${keepAwake.reason ? ` (${keepAwake.reason})` : ""}`
        : `keep-awake: ${keepAwake.enabled ? "on" : "off"}${keepAwake.active ? ", holding" : ""}`;
    // One quiet line; the footer already names the conversation and the keys.
    screen.print(dim(awake));
  };

  const banner = () => {
    const key = follow.current;
    const meta = key ? follow.meta(key) : undefined;
    const where = project ?? meta?.cwd ?? process.cwd();
    for (const line of bannerLines(
      {
        version: (pkg as { version: string }).version,
        project: projectName ?? "all projects",
        agent: agentName(providerOf(key)),
        model: currentLabel(findOption(currentOptions(), "model")),
        path: displayPath(where),
      },
      paint,
      screen.columns(),
    )) {
      screen.print(line);
    }
  };

  /** A selector changed (here, on the phone, or by the agent): say so once. */
  const noteConfigChange = (before: ConfigOptionLike[], after: ConfigOptionLike[]) => {
    for (const category of ["model", "thought_level", "mode"] as const) {
      const was = currentLabel(findOption(before, category));
      const now = currentLabel(findOption(after, category));
      if (now && was && now !== was) {
        const label = category === "thought_level" ? "thinking" : category;
        screen.print(dim(`  ${label} → ${now}`));
      }
    }
    screen.refresh();
  };

  const onProviders = (message: wire.ProviderAnnounce) => {
    providers = message.providers;
    active = message.activeSessions;
    draftsSupported = message.drafts === true;
    const prevAwake = keepAwake;
    keepAwake = message.keepAwake;

    // First join: we could not name any session in our `hello`, so we have no
    // history. Say hello again naming every open session, and the daemon's
    // catch-up hands back what it still holds.
    if (!hydrated) {
      hydrated = true;
      if (active.length > 0) {
        for (const id of active) cursors[id] ??= 0;
        rehello();
        return;
      }
    }

    // Replays arrive before this frame on every join; apply them now.
    const batch = replays;
    replays = [];
    for (const replay of batch) {
      let last = 0;
      for (const event of replay.events) {
        ingest(replay.sessionId, event, false);
        last = Math.max(last, event.at);
      }
      if (last > 0) follow.meta(replay.sessionId).lastActivity = Math.max(follow.meta(replay.sessionId).lastActivity, last);
      if (replay.permissions) {
        const open = new Map<string, Extract<Rendered, { kind: "permission" }>>();
        for (const p of replay.permissions) open.set(p.requestId, permissionView(p.requestId, p.params));
        permissions.set(replay.sessionId, open);
      }
    }

    if (!everJoined) {
      everJoined = true;
      // Where each open conversation lives, so a project window can tell its
      // own from the rest (the announcement names sessions, not projects).
      if (project) {
        for (const id of active) if (!follow.meta(id).cwd) send({ t: "workspace.status", sessionId: id });
      }
      if (args.focus && active.includes(args.focus)) {
        // Opened from the phone for this conversation: start on it, then
        // follow the project as usual.
        follow.switchTo(args.focus);
      } else if (args.session === undefined) {
        const newest = follow.list(active)[0];
        if (newest) follow.switchTo(newest.sessionId);
      }
      banner();
      divider(follow.current);
      if (follow.current) showRecent(follow.current);
      statusLine();
      return;
    }
    if (reconnecting) {
      reconnecting = false;
      screen.print(dim("reconnected"));
      // Anything missed in the followed conversation while away.
      for (const replay of batch) {
        if (replay.sessionId !== follow.current) continue;
        // Already ingested above; show only what the catch-up delivered.
        const list = history.get(replay.sessionId) ?? [];
        const fresh = replay.events.reduce((n, e) => n + renderEvents(e.payload).length, 0);
        if (fresh > 0) for (const item of list.slice(-fresh)) show(item, replay.sessionId);
        endReply(replay.sessionId);
      }
      statusLine();
      return;
    }
    if (
      prevAwake &&
      keepAwake &&
      (prevAwake.enabled !== keepAwake.enabled || prevAwake.active !== keepAwake.active)
    ) {
      screen.print(dim(`keep-awake ${keepAwake.enabled ? "on" : "off"}${keepAwake.active ? " (holding)" : ""}`));
    }
  };

  const startPrompt = (sessionId: string, text: string, attachments: Attachment[]) => {
    send({ t: "session.prompt", sessionId, text, ...(attachments.length > 0 && { attachments }) });
  };

  const dispatch = (message: { t?: string } & Record<string, unknown>) => {
    switch (message.t) {
      case "providers":
        onProviders(message as unknown as wire.ProviderAnnounce);
        return;
      case "session.replay":
        replays.push(message as unknown as (typeof replays)[number]);
        return;
      case "session.event": {
        const event = message as unknown as { sessionId: string; seq: number; at: number; payload: unknown };
        if (!everJoined) return;
        ingest(event.sessionId, event, true);
        return;
      }
      case "session.started": {
        const started = message as {
          sessionId: string;
          providerId?: string;
          cwd?: string;
          requestId?: string;
          agentSessionId?: string;
          configOptions?: ConfigOptionLike[];
        };
        lastAgent = started.providerId ?? lastAgent;
        if (!active.includes(started.sessionId)) active = [...active, started.sessionId];
        if (Array.isArray(started.configOptions) && started.configOptions.length > 0) {
          sessionConfig.set(started.sessionId, started.configOptions);
        }
        const info = {
          providerId: started.providerId,
          cwd: started.cwd,
          ...(started.agentSessionId ? { agentSessionId: started.agentSessionId } : {}),
        };
        if (pendingResume && started.agentSessionId === pendingResume.agentSessionId) {
          Object.assign(follow.meta(started.sessionId), info, { lastActivity: Date.now() });
          follow.switchTo(started.sessionId);
          divider(started.sessionId);
          // The daemon queues a prompt against a session still loading, exactly
          // as it does for the phone's first message after a restart.
          startPrompt(started.sessionId, pendingResume.text, pendingResume.attachments);
          pendingResume = undefined;
        } else if (pendingStart && started.requestId === pendingStart.requestId) {
          Object.assign(follow.meta(started.sessionId), info, { lastActivity: Date.now() });
          follow.switchTo(started.sessionId);
          divider(started.sessionId);
          startPrompt(started.sessionId, pendingStart.text, pendingStart.attachments);
          pendingStart = undefined;
        } else if (follow.activity(started.sessionId, Date.now(), info)) {
          divider(started.sessionId);
        }
        screen.refresh();
        return;
      }
      case "session.config": {
        const config = message as { sessionId?: string; providerId?: string; configOptions?: ConfigOptionLike[] };
        if (!config.sessionId || !Array.isArray(config.configOptions)) return;
        const before = config.sessionId === follow.current ? currentOptions() : [];
        sessionConfig.set(config.sessionId, config.configOptions);
        if (config.sessionId === follow.current) noteConfigChange(before, config.configOptions);
        return;
      }
      case "provider.config":
      case "provider.capabilities": {
        const caps = message as { providerId?: string; configOptions?: ConfigOptionLike[]; commands?: unknown };
        if (!caps.providerId) return;
        const before = currentOptions();
        if (Array.isArray(caps.configOptions)) providerConfig.set(caps.providerId, caps.configOptions);
        if (Array.isArray(caps.commands)) providerCommands.set(caps.providerId, agentCommandList(caps.commands));
        if (providerOf(follow.current) === caps.providerId) noteConfigChange(before, currentOptions());
        return;
      }
      case "image": {
        const answer = message as { requestId?: string; uri?: string; dataUri?: string; error?: string };
        const request = answer.requestId ? imageRequests.get(answer.requestId) : undefined;
        if (!request || !answer.requestId) return;
        imageRequests.delete(answer.requestId);
        imageCache.set(request.image.src, answer.dataUri ? { dataUri: answer.dataUri } : { error: answer.error ?? "unavailable" });
        if (request.sessionId !== follow.current) return;
        if (answer.dataUri) drawImage(request.image, answer.dataUri);
        else screen.print(dim(`   [image: ${request.image.name}] ${answer.error ?? "unavailable"}`));
        return;
      }
      case "session.draft": {
        const draft = message as { sessionId?: string; text: string; from?: string };
        if (draftIsActivity(draft, ownId) && follow.activity(draft.sessionId ?? "", Date.now())) {
          divider(follow.current);
        }
        // A not-yet-started conversation's draft names no project, so a project
        // window cannot know it is its own and leaves it alone.
        const unplaced = project !== undefined && (draft.sessionId ?? "") === "";
        if (!unplaced && draftApplies(draft, ownId, follow.current) && draft.text !== screen.input) {
          // Replaced, never echoed: this change came from the other device.
          screen.setInput(draft.text);
        }
        return;
      }
      case "session.idle": {
        const idle = message as { sessionId: string; providerId?: string; folder?: string };
        Object.assign(follow.meta(idle.sessionId), {
          ...(idle.providerId && { providerId: idle.providerId }),
          ...(idle.folder && { folder: idle.folder }),
        });
        permissions.delete(idle.sessionId);
        if (idle.sessionId === follow.current) {
          endReply(idle.sessionId);
          screen.print(dim("  ✓ done"));
        }
        return;
      }
      case "workspaces": {
        const answer = message as { requestId?: string; refused?: boolean };
        if (!pendingProject || answer.requestId !== pendingProject.requestId) return;
        const { text, agent, attachments } = pendingProject;
        pendingProject = undefined;
        if (answer.refused) {
          screen.print(red(`! pew2 can't open ${project} (only folders under your home are allowed)`));
          if (!screen.input) screen.setInput(text);
          return;
        }
        pendingStart = { requestId: `chat-${randomBytes(4).toString("hex")}`, text, attachments };
        send({ t: "session.start", requestId: pendingStart.requestId, providerId: agent, cwd: project });
        return;
      }
      case "workspace": {
        const ws = message as { sessionId?: string; cwd?: string; folder?: string };
        if (!ws.sessionId) return;
        const meta = follow.meta(ws.sessionId);
        const had = meta.cwd || meta.folder;
        Object.assign(meta, { cwd: ws.cwd, folder: ws.folder });
        // A project window learns which conversations are its own from these.
        // Waiting on an empty new conversation, it takes the newest that is.
        if (
          project &&
          args.session === undefined &&
          follow.current === "" &&
          active.includes(ws.sessionId) &&
          follow.inScope(ws.sessionId)
        ) {
          const newest = follow.list(active)[0];
          if (newest) {
            follow.switchTo(newest.sessionId);
            divider(newest.sessionId);
            showRecent(newest.sessionId);
          }
          return;
        }
        if (!had && ws.sessionId === follow.current) screen.print(dim(`  in ${ws.folder ?? ws.cwd}`));
        return;
      }
      case "error":
        if (message.code === "resume_failed" && pendingResume) {
          // Give the words back rather than lose them with the failed reopen.
          if (!screen.input) screen.setInput(pendingResume.text);
          pendingResume = undefined;
        }
        screen.print(red(`! ${String(message.message ?? message.code)}`));
        return;
      default:
        // Frames this window has no use for (previews, voice, …).
        return;
    }
  };

  let socketGeneration = 0;
  function connect() {
    const generation = ++socketGeneration;
    joined = false;
    replays = [];
    channel = new SecureChannel(rootKey, "app");
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          t: "hello",
          wire: wire.WIRE_VERSION,
          role: "app",
          deviceId: ownId,
          proof: channel!.proof(ownId),
          cursors,
        }),
      );
      joined = true;
      attempt = 0;
      // Asked again on every connection: what a provider offers can change.
      capabilitiesAsked.clear();
    };
    ws.onmessage = (event) => {
      if (generation !== socketGeneration || typeof event.data !== "string") return;
      let raw: { t?: string; code?: string; message?: string };
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      if (raw.t === "error") {
        // Cleartext: refusals that stop the channel. Fatal, not retried.
        screen.print(red(raw.message ?? raw.code ?? "refused"));
        quit(1);
        return;
      }
      if (raw.t !== "e") return;
      const opened = channel?.open(raw);
      if (opened && typeof opened === "object") dispatch(opened as { t?: string } & Record<string, unknown>);
    };
    ws.onclose = () => {
      if (generation !== socketGeneration || quitting) return;
      joined = false;
      if (!reconnecting) {
        reconnecting = true;
        endReply();
        screen.print(dim("reconnecting…"));
      }
      scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    const timer = setTimeout(connect, backoffMs(attempt++));
    timer.unref?.();
    // Keep the process alive while waiting: stdin is ref'd anyway.
  }

  function rehello() {
    const old = socket;
    socketGeneration++;
    try {
      old?.close();
    } catch {
      // Already gone.
    }
    connect();
  }

  function quit(code: number) {
    if (quitting) return;
    quitting = true;
    throttle.cancel();
    if (screen.input !== "") throttle.update(follow.current, "");
    screen.close();
    process.stdout.write("\x1b[?2004l");
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    setTimeout(() => {
      try {
        socket?.close();
      } catch {
        // Already gone.
      }
      resolveExit(code);
    }, 50);
  }

  const answerPermission = (index: number): boolean => {
    const open = permissions.get(follow.current);
    const request = open ? [...open.values()][0] : undefined;
    if (!request) return false;
    const option = request.options[index - 1];
    if (!option) {
      screen.print(red(`! choose 1-${request.options.length}`));
      return true;
    }
    if (send({ t: "session.permission", sessionId: follow.current, requestId: request.requestId, optionId: option.optionId })) {
      open?.delete(request.requestId);
      screen.print(dim(`  → ${option.name}`));
    }
    return true;
  };

  /** `/model`, `/thinking`, `/mode`: list, or set through the daemon so the phone follows. */
  const configCommand = (name: string, arg: string) => {
    const category = CATEGORY_FOR_COMMAND[name]!;
    const option = findOption(currentOptions(), category);
    const agent = agentName(providerOf(follow.current));
    if (!arg) {
      if (!option) askCapabilities(follow.current);
      for (const line of listOption(option, category, agent)) screen.print(dim(line));
      return;
    }
    if (!option) {
      screen.print(red(`! ${listOption(undefined, category, agent)[0]}`));
      return;
    }
    const picked = pickOptionValue(option, arg);
    if ("error" in picked) {
      screen.print(red(`! ${picked.error}`));
      return;
    }
    const key = follow.current;
    if (key !== "" && active.includes(key)) {
      // The daemon answers every client with the new set, this one included.
      send({ t: "session.config", sessionId: key, configId: option.id, value: picked.value });
      screen.print(dim(`  setting ${option.name.toLowerCase()} to ${picked.name}…`));
      return;
    }
    const provider = providerOf(key);
    if (!provider) {
      screen.print(red("! no agent available — run pew2 setup"));
      return;
    }
    // No live session: remembered for the next one this agent starts.
    send({ t: "provider.config", providerId: provider, configId: option.id, value: picked.value });
    const before = currentOptions();
    const updated = (providerConfig.get(provider) ?? []).map((o) => (o.id === option.id ? { ...o, currentValue: picked.value } : o));
    providerConfig.set(provider, updated);
    screen.print(dim(`  ${option.name.toLowerCase()} for the next ${agentName(provider)} conversation: ${picked.name}`));
    noteConfigChange(before, updated);
  };

  /** `/shot` and `/attach`: one image as an attachment, with a message. */
  const sendImage = async (name: string, mimeType: string, bytes: Uint8Array, text: string) => {
    const built = buildAttachment(name, mimeType, bytes);
    if ("error" in built) {
      screen.print(red(`! ${built.error}`));
      return;
    }
    const problem = attachmentsError([built.attachment]);
    if (problem) {
      screen.print(red(`! ${problem}`));
      return;
    }
    deliver(text, [built.attachment]);
  };

  const command = (text: string) => {
    const route = routeSlash(text, currentCommands());
    if (route.kind === "agent") {
      // ACP slash commands travel as ordinary prompt text.
      deliver(route.text, []);
      return;
    }
    if (route.kind === "unknown") {
      screen.print(red(`! unknown command /${route.name} — try /help`));
      return;
    }
    const { name, arg } = route;
    switch (name) {
      case "help":
        for (const line of helpLines(currentCommands(), agentName(providerOf(follow.current)))) screen.print(dim(line));
        return;
      case "quit":
      case "exit":
        quit(0);
        return;
      case "model":
      case "thinking":
      case "mode":
        configCommand(name, arg);
        return;
      case "shot": {
        const area = /^area\b/i.test(arg);
        const message = (area ? arg.replace(/^area\b/i, "") : arg).trim() || DEFAULT_SHOT_TEXT;
        screen.print(dim(area ? "  drag a region to capture (Esc cancels)…" : "  taking a screenshot…"));
        void captureScreen(area).then((result) => {
          if ("error" in result) {
            screen.print(red(`! ${result.error}`));
            return;
          }
          return sendImage(screenshotName(new Date()), "image/png", result.bytes, message);
        });
        return;
      }
      case "attach": {
        const parsed = parseAttachArgs(arg, homedir());
        if (!parsed) {
          screen.print(dim("usage: /attach <path> [message]. Type /attach then drop an image file on this window."));
          return;
        }
        const mimeType = imageMimeForPath(parsed.path);
        if (!mimeType) {
          screen.print(red(`! ${basename(parsed.path)} is not an image pew2 can send`));
          return;
        }
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(readFileSync(resolve(parsed.path)));
        } catch {
          screen.print(red(`! can't read ${parsed.path}`));
          return;
        }
        void sendImage(basename(parsed.path), mimeType, bytes, parsed.message || `Here's ${basename(parsed.path)}.`);
        return;
      }
      case "sessions": {
        const list = follow.list(active);
        if (list.length === 0) screen.print(dim("no open conversations — just type to start one"));
        list.forEach((row, i) =>
          screen.print(`${row.sessionId === follow.current ? "*" : " "} ${i + 1}. ${describe(row.sessionId)}`),
        );
        return;
      }
      case "switch": {
        const row = follow.list(active)[Number(arg) - 1];
        if (!row) {
          screen.print(red(`! no conversation ${arg} — see /sessions`));
          return;
        }
        follow.switchTo(row.sessionId);
        divider(row.sessionId);
        showRecent(row.sessionId);
        return;
      }
      case "new":
        follow.switchTo("");
        divider("");
        return;
      case "cancel":
        if (!follow.current) screen.print(dim("nothing running here"));
        else send({ t: "session.cancel", sessionId: follow.current });
        return;
      case "awake": {
        if (arg !== "on" && arg !== "off") {
          screen.print(dim("usage: /awake on|off"));
          return;
        }
        if (!keepAwake) {
          screen.print(red("! this daemon is older than keep-awake"));
          return;
        }
        send({ t: "daemon.keepAwake", enabled: arg === "on" });
        return;
      }
    }
  };

  /** Send a prompt (with any attachments) to what Enter goes to, starting or reopening it as needed. */
  function deliver(text: string, attachments: Attachment[]) {
    if (!joined) {
      screen.print(red("! not connected — kept your message"));
      if (attachments.length === 0) screen.setInput(text);
      return;
    }
    throttle.cancel();
    if (follow.current !== "") {
      if (!active.includes(follow.current)) {
        const meta = follow.meta(follow.current);
        if (meta.agentSessionId && meta.providerId) {
          // Closed under us (daemon restarted, or reaped idle): reopen it the
          // same way the phone does, then send.
          pendingResume = { agentSessionId: meta.agentSessionId, text, attachments };
          send({
            t: "session.resume",
            providerId: meta.providerId,
            agentSessionId: meta.agentSessionId,
            ...(meta.cwd ? { cwd: meta.cwd } : {}),
          });
          screen.print(dim("reopening this conversation…"));
          return;
        }
        screen.print(red("! this conversation is no longer open on this machine — reopen it from the phone, or /new"));
        if (attachments.length === 0) screen.setInput(text);
        return;
      }
      startPrompt(follow.current, text, attachments);
      return;
    }
    const agent = pickAgent(args.agent, lastAgent, providers);
    if (!agent) {
      screen.print(red("! no agent available — run pew2 setup"));
      if (attachments.length === 0) screen.setInput(text);
      return;
    }
    if (project) {
      pendingProject = { requestId: `chat-ws-${randomBytes(4).toString("hex")}`, text, agent, attachments };
      send({ t: "workspaces", requestId: pendingProject.requestId, path: project });
      screen.print(dim(`starting ${agentName(agent)} in ${projectName}…`));
      return;
    }
    pendingStart = { requestId: `chat-${randomBytes(4).toString("hex")}`, text, attachments };
    send({ t: "session.start", requestId: pendingStart.requestId, providerId: agent });
    screen.print(dim(`starting ${agentName(agent)}…`));
  }

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const slash = /^\/[a-z]/i.test(trimmed);
    if (slash || /^\d+$/.test(trimmed)) {
      // Not a prompt, so the daemon will not clear the mirrored draft itself.
      throttle.update(follow.current, "");
    }
    if (slash) {
      command(trimmed);
      return;
    }
    if (/^\d+$/.test(trimmed) && answerPermission(Number(trimmed))) return;
    deliver(text, []);
  };

  const complete = (input: string): string => {
    const names = [...LOCAL_COMMANDS.map((c) => c.name), ...currentCommands().map((c) => c.name)];
    const result = completeSlash(input, names);
    if (result.candidates.length > 1) screen.print(dim(result.candidates.map((n) => `/${n}`).join("  ")));
    return result.input;
  };

  // Raw mode: every keystroke is ours, so drafts can mirror letter by letter.
  const pasteState = { pasting: false };
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdout.write("\x1b[?2004h");
  process.stdin.on("data", (chunk: string) => {
    const before = screen.input;
    const { buffer: typed, actions } = applyInput(before, chunk, pasteState);
    if (actions.some((action) => action.kind === "quit")) {
      quit(0);
      return;
    }
    const buffer = actions.some((action) => action.kind === "tab") ? complete(typed) : typed;
    const submitted = actions.flatMap((action) => (action.kind === "submit" ? [action.text] : []));
    if (submitted.length > 0) {
      screen.setInput(buffer);
      for (const text of submitted) submit(text);
      return;
    }
    if (buffer !== before) {
      screen.setInput(buffer);
      throttle.update(follow.current, buffer);
    }
  });
  process.stdin.resume();
  process.on("SIGTERM", () => quit(0));

  connect();
  return exited;
}
