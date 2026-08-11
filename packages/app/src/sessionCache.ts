/**
 * The drawer's history, kept on this phone so it survives being closed.
 *
 * Every conversation the app shows arrives from the daemon: the list is built
 * from `provider.capabilities` and lives in React state, so a cold start began
 * with an empty drawer and stayed empty until a daemon answered. That reads as
 * data loss — "I restarted and all my conversations are gone" — when nothing
 * was lost at all; the agent's copy was on the desktop's disk the whole time.
 * It is also the state on a plane, on a train, or any time the desk machine is
 * asleep, which is exactly when a phone client is worth having.
 *
 * So the list is written to this device and read back before the socket opens.
 * What is stored is the *index* — title, agent, project, when — and never the
 * turns. Transcripts are the large, sensitive part, they are already durable on
 * the machine that ran them, and a resumed conversation replaces whatever this
 * file could have held anyway. Storing them would multiply the size of this
 * cache by a thousand to duplicate something the agent hands back on request.
 *
 * Pure and react-free, like `agentHistory.ts` beside it: the rules below are
 * the fiddly part and are directly testable. The file itself is written by
 * `sessionCacheFile.ts`, which is the half that needs Expo.
 */
import { agentSessionKey } from "./agentHistory";
import type { Session } from "./useDaemon";

/**
 * How many conversations are remembered.
 *
 * Well above the drawer's own thirty, because that limit applies *after* the
 * list is narrowed to one agent and one project: showing thirty rows for the
 * repo you picked can easily mean holding several hundred across everything.
 * Each record is a couple of hundred bytes, so this is tens of kilobytes.
 */
export const SESSION_CACHE_LIMIT = 150;

/**
 * One conversation, as stored.
 *
 * Deliberately a separate type from `Session` rather than a `Pick` of it. This
 * is a file format: it is written by one version of the app and read by the
 * next, so every field here is a compatibility commitment, and it should take
 * a decision to add one rather than happening as a side effect of a new field
 * on the session type.
 */
export interface CachedSession {
  /** Already the agent-stub form. See `toCachedSessions`. */
  id: string;
  providerId: string;
  title: string;
  startedAt: number;
  /** The agent's own id: the only thing that can reopen this next launch. */
  agentSessionId: string;
  cwd?: string;
  folder?: string;
  messageCount?: number;
  unread?: boolean;
}

/** The stored file, versioned so a future format change can be detected. */
export interface SessionCacheFile {
  version: 1;
  sessions: CachedSession[];
}

/**
 * Reduce the live list to what is worth keeping.
 *
 * Two rules do the real work.
 *
 * Sessions with no `agentSessionId` are dropped. A session id is assigned by
 * the daemon process that created it and dies with that process, so restoring
 * one would put a row in the drawer that answers "Unknown session" on the next
 * prompt — worse than not showing it, because it looks like the conversation
 * was corrupted rather than simply not cached. The agent's id is what reopens
 * a thread, and an entry without one cannot be reopened by anybody.
 *
 * The survivors are re-keyed to the agent-stub id. Next launch this entry *is*
 * a stub — its turns are on the agent's disk and arrive on resume — so storing
 * it under its old live id would be storing a lie, and one with teeth: ids are
 * handed out per daemon process, so the id a session had yesterday may belong
 * to a different conversation today. Writing the key the entry will need means
 * `needsResume` and `mergeAgentSessions` treat a restored row exactly as they
 * treat one the agent just listed, with no third case to keep in step.
 */
export function toCachedSessions(
  sessions: Session[],
  limit: number = SESSION_CACHE_LIMIT,
): CachedSession[] {
  return sessions
    .filter((session) => !!session.agentSessionId && !!session.providerId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
    .map((session) => {
      const agentSessionId = session.agentSessionId as string;
      const cached: CachedSession = {
        id: agentSessionKey(session.providerId, agentSessionId),
        providerId: session.providerId,
        title: session.title,
        startedAt: session.startedAt,
        agentSessionId,
      };
      // Written only when present, so the file does not fill with nulls that
      // mean the same as the absent key.
      if (session.cwd) cached.cwd = session.cwd;
      if (session.folder) cached.folder = session.folder;
      if (typeof session.messageCount === "number") cached.messageCount = session.messageCount;
      // `busy` is deliberately not stored: it describes an agent that was mid
      // turn in a process that no longer exists, and restoring it true would
      // show a spinner nothing can ever stop.
      if (session.unread) cached.unread = true;
      return cached;
    });
}

/**
 * Rebuild sessions from a parsed file, discarding anything malformed.
 *
 * Tolerant on purpose. This reads a file an older build wrote, that a crash may
 * have truncated, or that a future build has moved on from — and the cost of
 * being wrong is a drawer that will not load, on a launch where the daemon may
 * be unreachable and this is the only history there is. One bad record is
 * skipped; it does not take the rest with it.
 */
export function fromCachedSessions(parsed: unknown): Session[] {
  const file = parsed as Partial<SessionCacheFile> | null;
  if (!file || typeof file !== "object" || !Array.isArray(file.sessions)) return [];

  const sessions: Session[] = [];
  for (const entry of file.sessions as Partial<CachedSession>[]) {
    if (!entry || typeof entry !== "object") continue;
    const { id, providerId, title, startedAt, agentSessionId } = entry;
    if (typeof id !== "string" || id === "") continue;
    if (typeof providerId !== "string" || providerId === "") continue;
    if (typeof agentSessionId !== "string" || agentSessionId === "") continue;
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) continue;

    sessions.push({
      id,
      providerId,
      title: typeof title === "string" && title.trim() ? title : "Untitled conversation",
      startedAt,
      // Empty, always: turns were never stored, and the agent replaces them
      // wholesale when the conversation is opened.
      turns: [],
      // Likewise empty rather than remembered. A selector restored from disk
      // would be presented as this agent's current model and then silently
      // corrected once the session opened — the same trap `knownConfigs`
      // avoids by refusing to be seeded from fixtures.
      configOptions: [],
      agentSessionId,
      ...(typeof entry.cwd === "string" && entry.cwd ? { cwd: entry.cwd } : {}),
      ...(typeof entry.folder === "string" && entry.folder ? { folder: entry.folder } : {}),
      ...(typeof entry.messageCount === "number" ? { messageCount: entry.messageCount } : {}),
      ...(entry.unread === true ? { unread: true } : {}),
    });
  }

  return sessions.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * The only parts of the session list this cache can see.
 *
 * The same trick, and the same reason, as `projectSourceKey`: the sessions
 * array takes a new identity on every streamed chunk, because each one updates
 * the turns hanging off the active session. Writing the file on every one of
 * those would mean hundreds of disk writes per answered prompt, none of which
 * would change a byte — turns are not stored.
 *
 * This reduces the list to the fields that are, so an unchanged string is a
 * guarantee that the file would be unchanged too. Separators are control
 * characters because a title or path may contain any ordinary punctuation.
 */
export function sessionCacheKey(sessions: Session[]): string {
  let key = "";
  for (const session of sessions) {
    if (!session.agentSessionId) continue;
    key +=
      `${session.providerId}\u0000${session.agentSessionId}\u0000${session.title}` +
      `\u0000${session.startedAt}\u0000${session.cwd ?? ""}\u0000${session.folder ?? ""}` +
      `\u0000${session.messageCount ?? ""}\u0000${session.unread ? "1" : ""}\u0001`;
  }
  return key;
}
