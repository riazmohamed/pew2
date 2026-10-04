import type { Session } from "./useDaemon";

export const SESSION_HISTORY_LIMIT = 30;

/**
 * The identity a conversation is grouped under when the drawer decides what
 * deserves a row: its project, by the same precedence `sessionInProject`
 * matches on. A session this app started carries only a folder name until the
 * daemon stamps the full path at the end of its first turn, so the name is the
 * fallback rather than nothing — an unplaced conversation sharing one
 * anonymous group still keeps a single row instead of all of them vanishing.
 * The prefix keeps a path and a bare name from ever reading as one group.
 */
function projectKey(session: Pick<Session, "cwd" | "folder">): string {
  if (session.cwd) return session.cwd;
  return session.folder !== undefined ? `folder:${session.folder}` : "";
}

/**
 * The drawer's visible list: the newest conversations, with one row guaranteed
 * per project.
 *
 * A flat "newest N" slice is only a recent-work window while the user works in
 * one or two repos. With dozens of projects sharing thirty rows, a repo last
 * touched a week ago has no row at all, and its conversations read as lost
 * rather than as old — which is exactly how it presents on a phone, where the
 * project selector that would reach them is one unlabelled row above. So the
 * first pass takes the newest conversation of every project, and the second
 * spends whatever is left on the newest overall. A quiet project keeps exactly
 * one visible row however busy the rest are.
 *
 * The result is sorted newest first whichever pass picked a row, so the list
 * still reads as a timeline. With a project already chosen the caller has
 * filtered to one group, and both passes together are the plain cap they were.
 */
export function recentSessionsForProvider<
  T extends Pick<Session, "providerId" | "cwd" | "folder" | "startedAt">,
>(sessions: readonly T[], providerId?: string): T[] {
  const ordered = sessions
    .filter((session) => !providerId || session.providerId === providerId)
    .sort((a, b) => b.startedAt - a.startedAt);

  const picked: T[] = [];
  const taken = new Set<T>();
  const represented = new Set<string>();
  for (const session of ordered) {
    if (picked.length >= SESSION_HISTORY_LIMIT) break;
    const group = projectKey(session);
    if (represented.has(group)) continue;
    represented.add(group);
    picked.push(session);
    taken.add(session);
  }
  for (const session of ordered) {
    if (picked.length >= SESSION_HISTORY_LIMIT) break;
    if (taken.has(session)) continue;
    picked.push(session);
  }

  return picked.sort((a, b) => b.startedAt - a.startedAt);
}
