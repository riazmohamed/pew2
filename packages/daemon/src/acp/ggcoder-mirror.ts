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
import { encodeCwd, isTranscriptMessage, messageDisplayUpdates, type GgCoderDisplayUpdate } from "./ggcoder-history.js";

const gunzipAsync = promisify(gunzip);

/** Slow safety net under `fs.watch`, which can miss events on some volumes. */
export const MIRROR_POLL_MS = 2_000;

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
    const entry = JSON.parse(text.split("\n")[0] ?? "") as { type?: unknown; id?: unknown; conversationId?: unknown };
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

/** Every entry id in a file, for the "already on the phone" set. */
async function entryIds(file: string): Promise<{ ids: Set<string>; bytes: number }> {
  const raw = await readFile(file);
  const text = file.endsWith(".gz") ? (await gunzipAsync(raw)).toString("utf8") : raw.toString("utf8");
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { id?: unknown };
      if (typeof entry.id === "string") ids.add(entry.id);
    } catch {
      // A torn tail is finished by OG Coder; it is read again then.
    }
  }
  return { ids, bytes: file.endsWith(".gz") ? 0 : raw.length };
}

/**
 * The file OG Coder is writing this conversation to: the newest plain `.jsonl`
 * whose header names it, falling back to an archive when only that exists.
 */
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
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private draining?: Promise<void>;
  private again = false;
  private stopped = false;
  private expectedEcho: string[] = [];

  constructor(
    private readonly options: {
      agentSessionId: string;
      cwd: string;
      callbacks: MirrorCallbacks;
      sessionsRoot?: string;
      pollMs?: number;
    },
  ) {
    this.directory = path.join(options.sessionsRoot ?? path.join(homedir(), ".gg", "sessions"), encodeCwd(options.cwd));
  }

  /**
   * Take the baseline (everything already written) without watching yet. Run
   * before the window opens, so whatever OG Coder writes on resume is new.
   */
  async baseline(): Promise<void> {
    const found = await findConversationFile(this.directory, { agentSessionId: this.options.agentSessionId });
    if (!found) return;
    this.conversationId = found.header.conversationId;
    const { ids, bytes } = await entryIds(found.file);
    for (const id of ids) this.seen.add(id);
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
        await this.drain().catch((error) => console.error(`[native] mirror read failed: ${String(error)}`));
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async drain(): Promise<void> {
    const found = await findConversationFile(this.directory, {
      agentSessionId: this.options.agentSessionId,
      conversationId: this.conversationId,
    });
    if (!found || found.file.endsWith(".gz")) return;
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
      message?: { role?: string; content: unknown; provenance?: { kind?: string; visibility?: "transcript" | "hidden" | "summary" } };
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
    const { callbacks } = this.options;
    if (entry.type === "custom") {
      if (entry.kind === "run_started") callbacks.onTurnStart();
      else if (entry.kind === "run_finished") callbacks.onTurnEnd();
      return;
    }
    if (entry.type !== "message" || !entry.message) return;
    const message = entry.message;
    if (!isTranscriptMessage(message)) return;
    const updates = messageDisplayUpdates(message, { tools: true });
    if (message.role === "user") {
      const user = updates.find((update) => update.sessionUpdate === "user_message_chunk");
      if (!user) return;
      const content = user.content as { text?: string } | { text?: string }[];
      const text = (Array.isArray(content) ? content[0]?.text : content.text) ?? "";
      // A prefix, not equality: attachment paths are typed after the text,
      // and OG Coder may turn an image path into an attachment of its own.
      const echoed = this.expectedEcho.findIndex((expected) => text.trim().startsWith(expected));
      if (echoed >= 0) {
        this.expectedEcho.splice(echoed, 1);
        callbacks.onTurnStart();
        return;
      }
      // Pictures pasted at the desk keep the history shape, which carries them.
      if (Array.isArray(content)) callbacks.onUpdate(user);
      else callbacks.onUserMessage(text);
      callbacks.onTurnStart();
      return;
    }
    for (const update of updates) callbacks.onUpdate(update);
  }
}
