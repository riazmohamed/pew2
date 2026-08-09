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
import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

/** The OS temp root, resolved once. Real projects do not live here. */
const TEMP_ROOT = tmpdir();

/**
 * Whether a path is inside the OS temp directory.
 *
 * macOS reports the temp root as `/var/folders/…` while a process's own cwd
 * resolves through `/private`, so both spellings have to be recognised or the
 * filter silently matches nothing on the platform that needs it most.
 */
function isScratch(path: string): boolean {
  const roots = [TEMP_ROOT, `/private${TEMP_ROOT}`, TEMP_ROOT.replace(/^\/private/, "")];
  return roots.some((root) => root.length > 1 && path.startsWith(`${root}/`));
}

/**
 * Whether a project directory is still on disk, memoised per call.
 *
 * A `stat` per session would be hundreds of syscalls for one list; the number of
 * distinct project directories is small.
 */
function directoryExistsWith(
  cache: Map<string, boolean>,
  probe: (path: string) => boolean = (path) => existsSync(path),
) {
  return (path: string): boolean => {
    const known = cache.get(path);
    if (known !== undefined) return known;
    const exists = probe(path);
    cache.set(path, exists);
    return exists;
  };
}

/** Every session file under one encoded-cwd directory. */
async function filesIn(directory: string): Promise<string[]> {
  try {
    const names = await readdir(directory);
    return names
      .filter((name) => name.endsWith(".jsonl") || name.endsWith(".jsonl.gz"))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}

/**
 * Stored GG Coder conversations, newest first.
 *
 * With a `cwd`, only that project's conversations. With none, *every* project's
 * — which is not a convenience: the daemon calls `session/list` with no
 * arguments and folds the result into the app's project picker. Defaulting to
 * `process.cwd()` instead made that call return the sessions of whatever
 * directory the daemon happened to start in — `/` under launchd, so nothing at
 * all — and the picker sat there looking for folders that were never coming.
 *
 * An unreadable directory yields an empty list rather than an error: "no
 * previous conversations here" is the correct thing to show for a project the
 * agent has never been run in, which is indistinguishable at this level.
 */
export interface ListOptions {
  /**
   * Whether a project directory is still on disk.
   *
   * Injected so tests can describe projects at stable paths without creating
   * them — and, more to the point, without putting them under the OS temp
   * directory, which the scratch filter below exists to reject.
   */
  exists?: (path: string) => boolean;
}

export async function listStoredSessions(
  cwd?: string,
  sessionsRoot = join(homedir(), ".gg", "sessions"),
  options: ListOptions = {},
): Promise<StoredSession[]> {
  let paths: string[];
  if (cwd) {
    paths = await filesIn(join(sessionsRoot, encodeCwd(cwd)));
  } else {
    let dirs: string[];
    try {
      dirs = await readdir(sessionsRoot);
    } catch {
      return [];
    }
    const perDir = await Promise.all(dirs.map((dir) => filesIn(join(sessionsRoot, dir))));
    paths = perDir.flat();
  }

  const described = await Promise.all(paths.map((path) => describe(path)));

  const directoryExists = directoryExistsWith(new Map(), options.exists);
  const sessions = described
    .filter((entry): entry is StoredSession => entry !== undefined)
    // A project whose directory is gone cannot be opened, and offering it means
    // the session fails at spawn. Checked once per directory, not once per
    // session, since a busy project has hundreds.
    .filter((entry) => !entry.cwd || directoryExists(entry.cwd))
    // Scratch directories are not projects. `pew2 providers verify` spawns a
    // real session in a temp directory and deliberately leaves it behind (the
    // agent may still be exiting), so without this every verification run adds
    // a `pew2-verify-…` row to the user's project picker — pew2 littering its
    // own UI.
    .filter((entry) => !isScratch(entry.cwd));
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
