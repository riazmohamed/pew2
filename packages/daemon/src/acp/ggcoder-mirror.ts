/**
 * Follow a GG/OG Coder conversation that is running in its own terminal window.
 *
 * Once a conversation is handed over to the real OG Coder app, pew2 no longer
 * speaks ACP to it: the only record of what happens is the JSONL file OG Coder
 * appends one entry to as it goes. This tails that file and turns each new
 * entry into the same display updates history renders, plus the turn markers
 * (`run_started` / `run_finished`) that drive the phone's spinner.
 *
 * Nothing written before the handover is re-emitted: every entry id already in
 * the file at `start()` is remembered, and the read offset starts at its end.
 * The ids also cover OG Coder thawing a cold `.jsonl.gz` back into a `.jsonl`
 * (the same entries, rewritten) and a compaction fork, which starts a new file
 * for the same conversation.
 */
import { watch, type FSWatcher } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import {
  assetDirFor,
  encodeCwd,
  isTranscriptMessage,
  messageDisplayUpdates,
  type GgCoderDisplayUpdate,
} from "./ggcoder-history.js";

const gunzipAsync = promisify(gunzip);

/** Slow safety net under `fs.watch`, which can miss events on some volumes. */
export const MIRROR_POLL_MS = 2_000;

/** How OG Coder opens the first message of a compacted conversation. */
const SUMMARY_PREFIX = "[Previous conversation summary]";

/**
 * A compaction checkpoint copies the kept transcript in one burst right after
 * its header: entries written within this long of the header are the copy.
 */
export const CHECKPOINT_COPY_MS = 2_000;

/** The text of a message's content, as OG Coder reads a prompt. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** A user prompt worth recognising a conversation by (not a summary). */
function promptOf(entry: {
  type?: unknown;
  message?: { role?: unknown; content?: unknown };
}): string | undefined {
  if (entry.type !== "message" || entry.message?.role !== "user") return undefined;
  const text = contentText(entry.message.content);
  return text && !text.startsWith(SUMMARY_PREFIX) ? text : undefined;
}

/**
 * Whether `text` (a whole `.jsonl`) is OG Coder's compaction checkpoint of the
 * conversation whose prompts so far are `prompts`. OG Coder's own window saves
 * a compacted conversation as a new session with a new id and no link back to
 * the old one, so it is recognised by what it copied: a summary first, then
 * a run of our prompts in order. `"wait"` while the copy may still be being
 * written.
 */
export function checkpointOf(
  text: string,
  prompts: readonly string[],
  now = Date.now(),
): { id: string; conversationId: string; copied: Set<string> } | "wait" | undefined {
  const lines = text.split("\n");
  let header: { type?: unknown; id?: unknown; conversationId?: unknown; timestamp?: unknown };
  try {
    header = JSON.parse(lines[0] ?? "");
  } catch {
    return lines.length > 1 ? undefined : "wait";
  }
  if (header.type !== "session" || typeof header.id !== "string") return undefined;
  const born = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
  if (!Number.isFinite(born)) return undefined;
  if (now < born + CHECKPOINT_COPY_MS) return "wait";
  const copied = new Set<string>();
  const copiedPrompts: string[] = [];
  let first = true;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    let entry: {
      type?: unknown;
      id?: unknown;
      timestamp?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (first && entry.type === "message") {
      first = false;
      if (
        entry.message?.role !== "user" ||
        !contentText(entry.message.content).startsWith(SUMMARY_PREFIX)
      )
        return undefined;
    }
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!(at <= born + CHECKPOINT_COPY_MS)) continue;
    if (typeof entry.id === "string") copied.add(entry.id);
    const prompt = promptOf(entry);
    if (prompt !== undefined) copiedPrompts.push(prompt);
  }
  if (first || copiedPrompts.length === 0) return undefined;
  // The copy keeps the newest prompts in order: a run of ours. The old file
  // may have had more since (the window resumed it again), so it need not be
  // the end of the run; a single copied prompt must be our latest.
  const runs = prompts
    .map((_, start) => start)
    .filter((start) => copiedPrompts.every((prompt, i) => prompts[start + i] === prompt));
  if (runs.length === 0) return undefined;
  if (copiedPrompts.length === 1 && copiedPrompts[0] !== prompts.at(-1)) return undefined;
  return {
    id: header.id,
    conversationId: typeof header.conversationId === "string" ? header.conversationId : header.id,
    copied,
  };
}

export interface MirrorCallbacks {
  /** A display update, shaped like history (`{ sessionUpdate, ... }`). */
  onUpdate: (update: GgCoderDisplayUpdate) => void;
  /** A user message typed into the window (or sent from the phone). */
  onUserMessage: (text: string) => void;
  onTurnStart: () => void;
  onTurnEnd: () => void;
}

interface Header {
  id: string;
  conversationId: string;
}

async function readHeader(file: string): Promise<Header | undefined> {
  try {
    const text = file.endsWith(".gz")
      ? (await gunzipAsync(await readFile(file))).toString("utf8")
      : await firstLine(file);
    const entry = JSON.parse(text.split("\n")[0] ?? "") as {
      type?: unknown;
      id?: unknown;
      conversationId?: unknown;
    };
    if (entry.type !== "session" || typeof entry.id !== "string") return undefined;
    return {
      id: entry.id,
      conversationId: typeof entry.conversationId === "string" ? entry.conversationId : entry.id,
    };
  } catch {
    return undefined;
  }
}

async function firstLine(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Every entry id in a file, for the "already on the phone" set, and its prompts. */
async function entryIds(
  file: string,
): Promise<{ ids: Set<string>; bytes: number; prompts: string[] }> {
  const raw = await readFile(file);
  const text = file.endsWith(".gz")
    ? (await gunzipAsync(raw)).toString("utf8")
    : raw.toString("utf8");
  const ids = new Set<string>();
  const prompts: string[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as {
        id?: unknown;
        type?: unknown;
        message?: { role?: unknown; content?: unknown };
      };
      if (typeof entry.id === "string") ids.add(entry.id);
      const prompt = promptOf(entry);
      if (prompt !== undefined) prompts.push(prompt);
    } catch {
      // A torn tail is finished by OG Coder; it is read again then.
    }
  }
  return { ids, bytes: file.endsWith(".gz") ? 0 : raw.length, prompts };
}

/**
 * The file OG Coder is writing this conversation to: the newest plain `.jsonl`
 * whose header names it, falling back to an archive when only that exists.
 */
/**
 * The conversation OG Coder started in `directory` since `since` (ms): the
 * newest plain `.jsonl` not in `known`, by its header. A freshly launched OG
 * Coder writes its header at start, so this appears within moments.
 */
export async function findNewConversation(
  directory: string,
  known: ReadonlySet<string>,
  since: number,
): Promise<{ file: string; agentSessionId: string } | undefined> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return undefined;
  }
  let best: { file: string; agentSessionId: string; mtime: number } | undefined;
  for (const name of names) {
    if (!name.endsWith(".jsonl") || known.has(name)) continue;
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => undefined);
    if (!info || info.birthtimeMs < since - 2_000) continue;
    const header = await readHeader(file);
    if (!header?.id) continue;
    if (!best || info.mtimeMs > best.mtime)
      best = { file, agentSessionId: header.id, mtime: info.mtimeMs };
  }
  return best && { file: best.file, agentSessionId: best.agentSessionId };
}

/** Names of the conversation files already in `directory`. */
export async function conversationNames(directory: string): Promise<Set<string>> {
  try {
    return new Set((await readdir(directory)).filter((name) => name.endsWith(".jsonl")));
  } catch {
    return new Set();
  }
}

export async function findConversationFile(
  directory: string,
  identity: { agentSessionId: string; conversationId?: string },
): Promise<{ file: string; header: Header } | undefined> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return undefined;
  }
  const candidates: { file: string; header: Header; mtime: number; gz: boolean }[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl") && !name.endsWith(".jsonl.gz")) continue;
    const file = path.join(directory, name);
    const header = await readHeader(file);
    if (!header) continue;
    const matches =
      header.id === identity.agentSessionId ||
      header.conversationId === identity.agentSessionId ||
      (identity.conversationId !== undefined && header.conversationId === identity.conversationId);
    if (!matches) continue;
    const info = await stat(file).catch(() => undefined);
    if (info) candidates.push({ file, header, mtime: info.mtimeMs, gz: name.endsWith(".gz") });
  }
  // Plain files first (that is where appends land), then newest.
  candidates.sort((a, b) => Number(a.gz) - Number(b.gz) || b.mtime - a.mtime);
  const best = candidates[0];
  return best ? { file: best.file, header: best.header } : undefined;
}

export class GgCoderMirror {
  private readonly directory: string;
  private readonly seen = new Set<string>();
  private file?: string;
  private offset = 0;
  private partial = "";
  private conversationId?: string;
  /** The session id being followed: the handed-over one, then any checkpoint of it. */
  private followId: string;
  /** The conversation's prompts so far, to recognise its compaction checkpoint. */
  private readonly prompts: string[] = [];
  /** Files already in the folder at the baseline, and new ones ruled out. */
  private known = new Set<string>();
  /** New files that are not our checkpoint, by how many prompts we knew then. */
  private readonly ruledOut = new Map<string, number>();
  private startedAt = Date.now();
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private draining?: Promise<void>;
  private again = false;
  private stopped = false;
  private expectedEcho: string[] = [];
  /** Pending end of a turn: fires once the file has been quiet a moment. */
  private endTimer?: NodeJS.Timeout;

  constructor(
    private readonly options: {
      agentSessionId: string;
      cwd: string;
      callbacks: MirrorCallbacks;
      sessionsRoot?: string;
      pollMs?: number;
      /** How long the file must be quiet after a final `turn_metric` before the turn ends. */
      turnEndQuietMs?: number;
      /** A user message with no metric yet: ended after this much quiet unless work shows. */
      batchSettleMs?: number;
    },
  ) {
    this.directory = path.join(
      options.sessionsRoot ?? path.join(homedir(), ".gg", "sessions"),
      encodeCwd(options.cwd),
    );
    this.followId = options.agentSessionId;
  }

  private scheduleEnd(quietMs = this.options.turnEndQuietMs ?? 800): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => this.endTurn(), quietMs);
    this.endTimer.unref?.();
  }

  private cancelEnd(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = undefined;
  }

  private endTurn(): void {
    this.cancelEnd();
    if (!this.stopped) this.options.callbacks.onTurnEnd();
  }

  /**
   * Take the baseline (everything already written) without watching yet. Run
   * before the window opens, so whatever OG Coder writes on resume is new.
   */
  async baseline(): Promise<void> {
    this.startedAt = Date.now();
    this.known = await conversationNames(this.directory);
    const found = await findConversationFile(this.directory, {
      agentSessionId: this.options.agentSessionId,
    });
    if (!found) return;
    this.conversationId = found.header.conversationId;
    const { ids, bytes, prompts } = await entryIds(found.file);
    for (const id of ids) this.seen.add(id);
    this.prompts.push(...prompts);
    if (!found.file.endsWith(".gz")) {
      this.file = found.file;
      this.offset = bytes;
    }
  }

  /** Start following. `baseline()` should have run first. */
  start(): void {
    try {
      this.watcher = watch(this.directory, () => void this.kick());
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // The poll below still follows the file.
    }
    this.timer = setInterval(() => void this.kick(), this.options.pollMs ?? MIRROR_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * The phone already echoed this prompt itself (with its attachments), so
   * the matching user message from the file is not shown a second time.
   */
  expectEcho(text: string): void {
    this.expectedEcho.push(text.trim());
  }

  /** Read whatever is new. Serialised; a kick during a read runs once more. */
  kick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    this.draining = (async () => {
      do {
        this.again = false;
        await this.drain().catch((error) =>
          console.error(`[native] mirror read failed: ${String(error)}`),
        );
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async drain(): Promise<void> {
    const found = await findConversationFile(this.directory, {
      agentSessionId: this.followId,
      conversationId: this.conversationId,
    });
    if (found && !found.file.endsWith(".gz")) {
      if (found.file !== this.file) {
        // A thawed archive or a compaction fork: read it whole, and let the
        // seen ids drop what is already on the phone.
        if (this.file) await this.readFrom(this.file);
        this.file = found.file;
        this.offset = 0;
        this.partial = "";
        this.conversationId ??= found.header.conversationId;
      }
      await this.readFrom(this.file);
    }
    await this.followCheckpoint();
  }

  /**
   * OG Coder's window compacts a long conversation into a new, unlinked
   * session and carries on there. Find that file among the ones created since
   * the handover and follow it, without repeating what it copied.
   */
  private async followCheckpoint(): Promise<void> {
    if (this.prompts.length === 0) return;
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return;
    }
    for (const name of names) {
      if (
        !name.endsWith(".jsonl") ||
        this.known.has(name) ||
        this.ruledOut.get(name) === this.prompts.length
      )
        continue;
      const file = path.join(this.directory, name);
      if (file === this.file) continue;
      const info = await stat(file).catch(() => undefined);
      if (!info) continue;
      if (info.birthtimeMs < this.startedAt - 2_000) {
        this.known.add(name);
        continue;
      }
      const checkpoint = checkpointOf(await readFile(file, "utf8").catch(() => ""), this.prompts);
      if (checkpoint === "wait") continue;
      if (!checkpoint) {
        // Looked at again only once another prompt has come through.
        this.ruledOut.set(name, this.prompts.length);
        continue;
      }
      // Whatever the old file still had comes first.
      if (this.file) await this.readFrom(this.file);
      for (const id of checkpoint.copied) this.seen.add(id);
      this.followId = checkpoint.id;
      this.conversationId = checkpoint.conversationId;
      this.file = file;
      this.offset = 0;
      this.partial = "";
      console.log(
        `[native] OG Coder compacted ${this.options.agentSessionId} into ${checkpoint.id}: following it`,
      );
      await this.readFrom(file);
      return;
    }
  }

  private async readFrom(file: string): Promise<void> {
    const info = await stat(file).catch(() => undefined);
    if (!info) return;
    if (file !== this.file) return;
    if (info.size < this.offset) {
      // Rewritten shorter: start over; seen ids prevent repeats.
      this.offset = 0;
      this.partial = "";
    }
    if (info.size === this.offset) return;
    const handle = await open(file, "r");
    let chunk: string;
    try {
      const length = info.size - this.offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;
      chunk = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const text = this.partial + chunk;
    const lines = text.split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) this.entry(line);
  }

  private entry(line: string): void {
    if (!line.trim() || this.stopped) return;
    let entry: {
      type?: unknown;
      id?: unknown;
      kind?: unknown;
      message?: {
        role?: string;
        content: unknown;
        provenance?: { kind?: string; visibility?: "transcript" | "hidden" | "summary" };
      };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof entry.id === "string") {
      if (this.seen.has(entry.id)) return;
      this.seen.add(entry.id);
    }
    const prompt = promptOf(
      entry as { type?: unknown; message?: { role?: unknown; content?: unknown } },
    );
    if (prompt !== undefined) this.prompts.push(prompt);
    const { callbacks } = this.options;
    if (entry.type === "custom") {
      if (entry.kind === "run_started") callbacks.onTurnStart();
      else if (entry.kind === "run_finished") this.endTurn();
      else if (entry.kind === "turn_metric") {
        // OG Coder's own screen writes no run journal. It leaves a
        // `turn_metric` as each model call ends, live, but the turn's messages
        // only when the turn is over, in one batch that can land either side
        // of the last metric. So a call that stopped to use a tool means work
        // is under way, and one that did not is the end, once the batch that
        // follows it has gone quiet.
        const stopReason = (entry as { data?: { stopReason?: unknown } }).data?.stopReason;
        if (stopReason === "tool_use" || stopReason === "pause_turn") {
          this.cancelEnd();
          callbacks.onTurnStart();
        } else {
          this.scheduleEnd();
        }
      }
      return;
    }
    // More of the turn arrived: a pending end waits for it to settle.
    if (this.endTimer) this.scheduleEnd();
    if (entry.type !== "message" || !entry.message) return;
    const message = entry.message;
    if (!isTranscriptMessage(message)) return;
    const updates = messageDisplayUpdates(message, {
      tools: true,
      ...(this.file && { assetDirs: [assetDirFor(this.file)] }),
    });
    if (message.role === "user") {
      const user = updates.find((update) => update.sessionUpdate === "user_message_chunk");
      if (!user) return;
      const content = user.content as { text?: string } | { text?: string }[];
      const text = (Array.isArray(content) ? content[0]?.text : content.text) ?? "";
      // A prefix, not equality: attachment paths are typed after the text,
      // and OG Coder may turn an image path into an attachment of its own.
      const echoed = this.expectedEcho.findIndex((expected) => text.trim().startsWith(expected));
      // Part of a finished turn's batch when an end is pending (handled
      // above): shown, but it starts nothing.
      const ending = this.endTimer !== undefined;
      if (echoed >= 0) {
        this.expectedEcho.splice(echoed, 1);
        if (!ending) {
          callbacks.onTurnStart();
          this.scheduleEnd(this.options.batchSettleMs ?? 5_000);
        }
        return;
      }
      // Pictures pasted at the desk keep the history shape, which carries them.
      if (Array.isArray(content)) callbacks.onUpdate(user);
      else callbacks.onUserMessage(text);
      if (!ending) {
        callbacks.onTurnStart();
        // Written with the turn's last batch, so the end may already be in
        // the file: it is settled by the quiet check, not left open forever.
        this.scheduleEnd(this.options.batchSettleMs ?? 5_000);
      }
      return;
    }
    for (const update of updates) callbacks.onUpdate(update);
  }
}
