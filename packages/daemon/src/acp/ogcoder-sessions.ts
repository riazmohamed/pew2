/**
 * Listing GG Coder's stored conversations for the app's sidebar.
 *
 * `--rpc` has no "list sessions" command, but GG Coder writes every
 * conversation to `~/.gg/sessions/<encoded-cwd>/<timestamp>_<id8>.jsonl` — the
 * same store pew2 already reads to paint transcripts. Enumerating it is
 * therefore not a workaround; it is the same source of truth, read one level
 * earlier.
 *
 * Only headers and the first user message are parsed. A session file can be
 * hundreds of megabytes, and the sidebar needs a title and a date.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

/**
 * GG Coder's cwd-to-directory encoding.
 *
 * Duplicated from `ggcoder-history.ts` rather than imported: that module is
 * daemon-internal and this file runs inside the bridge, a separate process with
 * no dependency on the daemon's graph. The encoding is part of GG Coder's
 * on-disk format, so it changes on GG Coder's schedule, not pew2's.
 */
export function encodeCwd(cwd: string): string {
  return cwd
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/i, "")
    .replace(/[\\/]/g, "_")
    .replace(/[<>:"|?*]/g, "")
    .replace(/^_/, "");
}

/** A row in the app's session list. */
export interface StoredSession {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: string;
}

/** Longest title we build. The sidebar truncates well before this. */
const TITLE_LIMIT = 60;

function titleFrom(content: unknown): string | undefined {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((part) =>
              typeof (part as { text?: unknown })?.text === "string"
                ? [(part as { text: string }).text]
                : [],
            )
            .join(" ")
        : "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > TITLE_LIMIT ? `${flat.slice(0, TITLE_LIMIT - 1)}…` : flat;
}

/**
 * Read just enough of one session file to describe it.
 *
 * Stops at the first user message: everything the sidebar shows is in the first
 * few lines, and a full parse of every file would make opening the app wait on
 * the entire history on disk.
 */
async function describe(filePath: string): Promise<StoredSession | undefined> {
  const source = createReadStream(filePath);
  const input = filePath.endsWith(".gz") ? source.pipe(createGunzip()) : source;
  const lines = createInterface({ input, crlfDelay: Infinity });

  let sessionId: string | undefined;
  let cwd = "";
  let timestamp: string | undefined;
  let title: string | undefined;

  try {
    for await (const line of lines) {
      if (!line) continue;
      let entry: {
        type?: string;
        id?: string;
        cwd?: string;
        timestamp?: string;
        message?: { role?: string; content?: unknown };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === "session" && typeof entry.id === "string") {
        sessionId = entry.id;
        cwd = typeof entry.cwd === "string" ? entry.cwd : "";
        timestamp = entry.timestamp;
        continue;
      }
      if (entry.type === "message" && entry.message?.role === "user") {
        title = titleFrom(entry.message.content);
        if (title) break;
      }
    }
  } catch {
    return undefined;
  } finally {
    lines.close();
    source.destroy();
  }

  if (!sessionId) return undefined;

  // mtime, not the header timestamp: the header records when the conversation
  // was *created*, so ordering by it puts a thread used all morning below one
  // opened once last week.
  let updatedAt = timestamp ?? new Date(0).toISOString();
  try {
    updatedAt = (await stat(filePath)).mtime.toISOString();
  } catch {
    // Header timestamp remains a reasonable fallback.
  }

  return { sessionId, cwd, title: title ?? "Untitled session", updatedAt };
}

/**
 * Every stored GG Coder conversation for one working directory, newest first.
 *
 * An unreadable directory yields an empty list rather than an error: "no
 * previous conversations here" is the correct thing to show for a project the
 * agent has never been run in, which is indistinguishable at this level.
 */
export async function listStoredSessions(
  cwd: string,
  sessionsRoot = join(homedir(), ".gg", "sessions"),
): Promise<StoredSession[]> {
  const directory = join(sessionsRoot, encodeCwd(cwd));
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }

  const files = names.filter((name) => name.endsWith(".jsonl") || name.endsWith(".jsonl.gz"));
  const described = await Promise.all(files.map((name) => describe(join(directory, name))));

  const sessions = described.filter((entry): entry is StoredSession => entry !== undefined);
  // Archival leaves a redirect stub beside its `.gz`, so one conversation can
  // appear twice. The newest wins; a duplicated row in the sidebar opens the
  // same thread twice and looks like data loss when one copy is stale.
  const newest = new Map<string, StoredSession>();
  for (const session of sessions) {
    const existing = newest.get(session.sessionId);
    if (!existing || existing.updatedAt < session.updatedAt) newest.set(session.sessionId, session);
  }

  return [...newest.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
