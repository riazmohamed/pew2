/**
 * The pure half of `pew2 chat`: which conversation to follow, how drafts are
 * throttled and de-echoed, how keystrokes edit the line, and how session events
 * read in a terminal. No sockets, no TTY, no clocks of its own — `chat.ts` owns
 * those and this stays testable.
 */
import { CLI_DEVICE_PREFIX } from "../device-claim.js";
import {
  imagesFromAttachments,
  imagesFromContent,
  imagesFromToolContent,
  type ChatImage,
} from "./chat-images.js";
import type { DiffView } from "./chat-theme.js";

/**
 * A distinct id per chat window, under the CLI prefix so `decideClaim` admits
 * it without claiming the phone's pairing, and `pew2 pair` never mistakes it
 * for a phone.
 */
export function chatDeviceId(host: string, random: string): string {
  return `${CLI_DEVICE_PREFIX}${host}#chat-${random}`;
}

/** The LAN socket URL, built as `pew2 pair` builds its watcher's. */
export function chatSocketUrl(port: number, token: string): string {
  return `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}

/** Draft key: a live session id, or "" for a conversation not started yet. */
export type ConversationKey = string;

export interface SessionMeta {
  providerId?: string;
  cwd?: string;
  folder?: string;
  /** The agent's own id for the conversation, which survives a daemon restart. */
  agentSessionId?: string;
  lastActivity: number;
}

/**
 * Is `cwd` inside `project`? Both are absolute paths; a trailing slash on
 * either is ignored, and a sibling that merely shares a prefix (`/a/app` vs
 * `/a/app2`) is not inside.
 */
export function insideProject(cwd: string | undefined, project: string): boolean {
  if (!cwd) return false;
  const trim = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);
  const a = trim(cwd);
  const b = trim(project);
  return a === b || a.startsWith(`${b}/`);
}

/**
 * Which conversation this window is following.
 *
 * Latest activity wins unless pinned with `--session`. "" means a new,
 * not-yet-started conversation (the next Enter starts one).
 *
 * With a `project`, the window belongs to that project: only conversations
 * whose cwd is inside it are followed or listed, so one window per project can
 * sit side by side without each one jumping to whatever the phone touched
 * last. A conversation whose cwd is not known yet is out of scope until it is.
 */
export class Follow {
  readonly sessions = new Map<string, SessionMeta>();
  current: ConversationKey;

  constructor(
    readonly pinned?: string,
    readonly project?: string,
  ) {
    this.current = pinned ?? "";
  }

  meta(sessionId: string): SessionMeta {
    let meta = this.sessions.get(sessionId);
    if (!meta) {
      meta = { lastActivity: 0 };
      this.sessions.set(sessionId, meta);
    }
    return meta;
  }

  /** Does this conversation belong in this window? */
  inScope(key: ConversationKey): boolean {
    if (this.project === undefined) return true;
    // A not-yet-started conversation on another device names no project, so a
    // project window cannot tell whose it is and leaves it alone.
    if (key === "") return false;
    return insideProject(this.sessions.get(key)?.cwd, this.project);
  }

  /**
   * Something happened in `key`. Returns true when the followed conversation
   * changed as a result, so the caller prints a divider.
   */
  activity(key: ConversationKey, now: number, info: Partial<SessionMeta> = {}): boolean {
    if (key !== "") Object.assign(this.meta(key), info, { lastActivity: now });
    if (this.pinned !== undefined) return false;
    if (key === this.current) return false;
    if (!this.inScope(key)) return false;
    this.current = key;
    return true;
  }

  /** Force a switch (`/switch`, `/new`). Ignores the pin: the user asked. */
  switchTo(key: ConversationKey): boolean {
    const changed = key !== this.current;
    this.current = key;
    return changed;
  }

  /** In-scope sessions newest first, for `/sessions`. */
  list(active: readonly string[]): { sessionId: string; meta: SessionMeta }[] {
    return active
      .filter((sessionId) => this.inScope(sessionId))
      .map((sessionId) => ({ sessionId, meta: this.meta(sessionId) }))
      .sort(
        (a, b) =>
          b.meta.lastActivity - a.meta.lastActivity || a.sessionId.localeCompare(b.sessionId),
      );
  }
}

/**
 * The agent a daemon session id belongs to. The daemon mints them as
 * `<providerId>-<base36 time>`; anything else yields undefined, and the caller
 * falls back to what it learns later (`session.idle` names the provider).
 */
export function providerFromSessionId(
  sessionId: string,
  providers: readonly { id: string }[],
): string | undefined {
  const cut = sessionId.lastIndexOf("-");
  if (cut <= 0) return undefined;
  const id = sessionId.slice(0, cut);
  return providers.some((p) => p.id === id) ? id : undefined;
}

/** Should an inbound draft replace this window's input? */
export function draftApplies(
  frame: { sessionId?: string; from?: string },
  ownId: string,
  followed: ConversationKey,
): boolean {
  if (frame.from === ownId) return false;
  return (frame.sessionId ?? "") === followed;
}

/**
 * Does an inbound draft count as activity worth following? Only someone else
 * actually typing: an empty draft is a clear (often the daemon's own, after a
 * prompt or a start) and would yank the window to an empty conversation.
 */
export function draftIsActivity(frame: { from?: string; text: string }, ownId: string): boolean {
  return frame.from !== ownId && frame.text !== "";
}

/** The agent for a new conversation: flag, last seen, ggcoder, first available. */
export function pickAgent(
  flag: string | undefined,
  lastSeen: string | undefined,
  providers: readonly { id: string; available: boolean }[],
): string | undefined {
  if (flag) return flag;
  if (lastSeen && providers.some((p) => p.id === lastSeen)) return lastSeen;
  if (providers.some((p) => p.id === "ggcoder" && p.available)) return "ggcoder";
  return providers.find((p) => p.available)?.id;
}

export interface TimerApi {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Trailing throttle for outgoing drafts: at most one frame per `delayMs`,
 * always carrying the latest text. Clearing is sent at once.
 */
export class DraftThrottle {
  private timer: unknown;
  private pending?: { key: ConversationKey; text: string };

  constructor(
    private readonly send: (key: ConversationKey, text: string) => void,
    private readonly delayMs = 60,
    private readonly timers: TimerApi = realTimers,
  ) {}

  update(key: ConversationKey, text: string) {
    if (text === "") {
      this.cancel();
      this.send(key, "");
      return;
    }
    if (this.pending && this.pending.key !== key) this.flush();
    this.pending = { key, text };
    if (this.timer === undefined) this.timer = this.timers.set(() => this.flush(), this.delayMs);
  }

  /** Drop anything not yet sent (a prompt went out; the daemon clears it). */
  cancel() {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  private flush() {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) this.send(pending.key, pending.text);
  }
}

export type EditAction = { kind: "submit"; text: string } | { kind: "quit" } | { kind: "tab" };

/**
 * Apply one chunk of raw-mode input to the line. Handles paste (many chars at
 * once, bracketed or not), backspace, Ctrl-U, Enter, and Esc/Ctrl-C/Ctrl-D to quit.
 */
export function applyInput(
  buffer: string,
  chunk: string,
  state: { pasting: boolean } = { pasting: false },
): { buffer: string; actions: EditAction[] } {
  const actions: EditAction[] = [];
  let i = 0;
  while (i < chunk.length) {
    const char = chunk[i]!;
    if (char === "\x1b") {
      if (chunk.startsWith("\x1b[200~", i)) {
        state.pasting = true;
        i += 6;
        continue;
      }
      if (chunk.startsWith("\x1b[201~", i)) {
        state.pasting = false;
        i += 6;
        continue;
      }
      // A lone Esc (nothing after it in this chunk) leaves, like OG Coder.
      // Arrow keys and other sequences arrive whole, `ESC [ ... final`.
      if (i === chunk.length - 1 && !state.pasting) {
        actions.push({ kind: "quit" });
        i++;
        continue;
      }
      let j = i + 1;
      if (chunk[j] === "[" || chunk[j] === "O") {
        j++;
        while (j < chunk.length && !/[A-Za-z~]/.test(chunk[j]!)) j++;
        j++;
      }
      i = j;
      continue;
    }
    i++;
    if (char === "\r" || char === "\n") {
      if (state.pasting) {
        buffer += "\n";
      } else if (!(char === "\n" && chunk[i - 2] === "\r")) {
        actions.push({ kind: "submit", text: buffer });
        buffer = "";
      }
      continue;
    }
    if (char === "\x03") {
      actions.push({ kind: "quit" });
      continue;
    }
    if (char === "\x04") {
      if (buffer === "") actions.push({ kind: "quit" });
      continue;
    }
    if (char === "\x7f" || char === "\b") {
      buffer = [...buffer].slice(0, -1).join("");
      continue;
    }
    if (char === "\x15") {
      buffer = "";
      continue;
    }
    if (char === "\t") {
      // Typed, Tab completes; inside a paste it is just whitespace.
      if (state.pasting) buffer += " ";
      else actions.push({ kind: "tab" });
      continue;
    }
    if (char < " ") continue;
    buffer += char;
  }
  return { buffer, actions };
}

export type Rendered =
  | { kind: "user"; text: string; images?: number }
  | { kind: "text"; text: string }
  | { kind: "tool"; text: string; id?: string; status?: string }
  | { kind: "toolResult"; id?: string; status?: string; diff?: DiffView }
  | { kind: "image"; image: ChatImage }
  | {
      kind: "permission";
      requestId: string;
      title: string;
      options: { optionId: string; name: string }[];
    }
  | { kind: "exit"; text: string };

function blockText(content: unknown): string {
  const parts = Array.isArray(content) ? content : [content];
  let text = "";
  for (const part of parts) {
    const block = part as { type?: unknown; text?: unknown } | null;
    if (typeof block?.text === "string") text += block.text;
  }
  return text;
}

/** A permission request's params, as numbered options. */
export function permissionView(
  requestId: string,
  params: unknown,
): Extract<Rendered, { kind: "permission" }> {
  const p = params as {
    toolCall?: { title?: unknown };
    options?: { optionId?: unknown; name?: unknown }[];
  } | null;
  const title =
    typeof p?.toolCall?.title === "string" ? p.toolCall.title : "The agent wants to continue";
  const options = (Array.isArray(p?.options) ? p.options : [])
    .filter((o) => typeof o?.optionId === "string")
    .map((o) => ({
      optionId: o.optionId as string,
      name: typeof o.name === "string" ? o.name : String(o.optionId),
    }));
  return { kind: "permission", requestId, title, options };
}

/**
 * A line-level diff simple enough for a terminal: lines only in the old text
 * are removed, lines only in the new are added (counted, so repeats survive).
 */
export function simpleDiff(
  path: string,
  oldText: string | null | undefined,
  newText: string,
): DiffView {
  const before = oldText ? oldText.split("\n") : [];
  const after = newText.split("\n");
  const counts = new Map<string, number>();
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of after) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else added.push(line);
  }
  const removed: string[] = [];
  for (const line of before) {
    const n = counts.get(line) ?? 0;
    if (n > 0) {
      removed.push(line);
      counts.set(line, n - 1);
    }
  }
  return { path, added, removed };
}

function diffsFrom(content: unknown): DiffView[] {
  if (!Array.isArray(content)) return [];
  const out: DiffView[] = [];
  for (const entry of content as {
    type?: unknown;
    path?: unknown;
    oldText?: unknown;
    newText?: unknown;
  }[]) {
    if (
      entry?.type !== "diff" ||
      typeof entry.path !== "string" ||
      typeof entry.newText !== "string"
    )
      continue;
    out.push(
      simpleDiff(
        entry.path,
        typeof entry.oldText === "string" ? entry.oldText : undefined,
        entry.newText,
      ),
    );
  }
  return out;
}

/** Everything one logged session event draws, in order (often nothing). */
export function renderEvents(payload: unknown): Rendered[] {
  const p = payload as {
    kind?: unknown;
    text?: unknown;
    attachments?: unknown;
    requestId?: unknown;
    params?: unknown;
    code?: unknown;
    update?: {
      sessionUpdate?: unknown;
      content?: unknown;
      title?: unknown;
      kind?: unknown;
      toolCallId?: unknown;
      status?: unknown;
    };
  } | null;
  if (!p || typeof p !== "object") return [];
  if (p.kind === "user_message" && typeof p.text === "string") {
    const images = imagesFromAttachments(p.attachments);
    return [
      { kind: "user", text: p.text, ...(images.length > 0 && { images: images.length }) },
      ...images.map((image): Rendered => ({ kind: "image", image })),
    ];
  }
  if (p.kind === "permission_request" && typeof p.requestId === "string") {
    return [permissionView(p.requestId, p.params)];
  }
  if (p.kind === "exit")
    return [
      { kind: "exit", text: `agent exited${typeof p.code === "number" ? ` (${p.code})` : ""}` },
    ];
  const update = p.update;
  const id = typeof update?.toolCallId === "string" ? update.toolCallId : undefined;
  const status = typeof update?.status === "string" ? update.status : undefined;
  switch (update?.sessionUpdate) {
    case "agent_message_chunk": {
      const text = blockText(update.content);
      const images = imagesFromContent(update.content).map((image): Rendered => ({
        kind: "image",
        image,
      }));
      return [...(text ? [{ kind: "text", text } as Rendered] : []), ...images];
    }
    case "user_message_chunk": {
      const text = blockText(update.content);
      return text ? [{ kind: "user", text }] : [];
    }
    case "tool_call": {
      const title = typeof update.title === "string" ? update.title : "tool";
      return [
        { kind: "tool", text: title, ...(id && { id }), ...(status && { status }) },
        ...diffsFrom(update.content).map((diff): Rendered => ({
          kind: "toolResult",
          ...(id && { id }),
          diff,
        })),
        ...imagesFromToolContent(update.content).map((image): Rendered => ({
          kind: "image",
          image,
        })),
      ];
    }
    case "tool_call_update": {
      const out: Rendered[] = diffsFrom(update.content).map((diff) => ({
        kind: "toolResult",
        ...(id && { id }),
        diff,
      }));
      if (status === "failed") out.push({ kind: "toolResult", ...(id && { id }), status });
      for (const image of imagesFromToolContent(update.content)) out.push({ kind: "image", image });
      return out;
    }
    default:
      return [];
  }
}

/** How one logged session event reads in a terminal: its first item, or undefined. */
export function renderEvent(payload: unknown): Rendered | undefined {
  return renderEvents(payload)[0];
}

/** Terminal rows a string occupies at `columns` wide (one row minimum). */
export function rowsFor(text: string, columns: number): number {
  const width = Math.max(1, columns);
  let rows = 0;
  for (const line of text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .split("\n")) {
    rows += Math.max(1, Math.ceil([...line].length / width));
  }
  return rows;
}

/** Reconnect delay for attempt n (0-based): 0.5s doubling, capped at 10s. */
export function backoffMs(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** Math.max(0, attempt));
}
