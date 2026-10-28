/**
 * The project picker's search: case-insensitive substring, with `*` as a
 * wildcard ("tmc*web" finds "tmc_fms_web").
 *
 * Pure and react-free so it is testable under `bun test`.
 */

/** Does `query` match `text`? An empty or all-`*` query matches everything. */
export function matchesProjectQuery(text: string, query: string): boolean {
  const parts = query
    .trim()
    .toLowerCase()
    .split("*")
    .filter((part) => part.length > 0);
  if (parts.length === 0) return true;
  const haystack = text.toLowerCase();
  // Substring semantics: every part in order, anywhere, so no anchoring.
  let from = 0;
  for (const part of parts) {
    const at = haystack.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

/**
 * Projects matching `query`, keeping the incoming order (newest work first
 * from `projectsForProvider`). The name is checked first, then the full path,
 * so "unstable*pew" finds a repo by its parent folder too; name matches lead.
 */
export function searchProjects<T extends { name: string; path: string }>(
  projects: readonly T[],
  query: string,
): T[] {
  if (query.trim().replace(/\*/g, "") === "") return [...projects];
  const byName: T[] = [];
  const byPath: T[] = [];
  for (const project of projects) {
    if (matchesProjectQuery(project.name, query)) byName.push(project);
    else if (matchesProjectQuery(project.path, query)) byPath.push(project);
  }
  return [...byName, ...byPath];
}
