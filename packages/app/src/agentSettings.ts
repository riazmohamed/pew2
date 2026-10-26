/**
 * The Agents settings rows: every agent the computer knows, on or off.
 *
 * Pure (no React Native) so `bun test` can read it. The daemon's `catalog` is
 * the truth; a tap flips the row at once and the re-announce confirms it.
 * Absent catalog means a daemon older than the settings, and no rows at all.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  enabled: boolean;
  installed: boolean;
  reason?: string;
}

export const AGENTS_NOTE = "Turned-off agents don't appear and never start on your computer.";

/** GG Goals is part of OG Coder on the computer. */
const GOALS_ID = "gg-goals";
const GG_CODER_ID = "ggcoder";

/** The catalog with one switch flipped, as the daemon will answer it. */
export function applyToggle(
  catalog: readonly CatalogEntry[],
  id: string,
  enabled: boolean,
): CatalogEntry[] {
  return catalog.map((entry) => {
    if (entry.id === id) return { ...entry, enabled };
    // Turning GG Goals on turns OG Coder on with it; turning OG Coder off
    // hides GG Goals, which follows it.
    if (id === GOALS_ID && enabled && entry.id === GG_CODER_ID) return { ...entry, enabled: true };
    if (id === GG_CODER_ID && !enabled && entry.id === GOALS_ID)
      return { ...entry, enabled: false };
    return entry;
  });
}

/** The one line under a row: why it cannot run, if anything. */
export function agentNote(entry: CatalogEntry): string | undefined {
  if (entry.reason) return entry.reason;
  if (!entry.installed) return "Not installed on this computer.";
  return undefined;
}

/** Installed agents first, each group in the daemon's order. */
export function agentRows(catalog: readonly CatalogEntry[] | undefined): CatalogEntry[] {
  if (!catalog) return [];
  return [...catalog.filter((e) => e.installed), ...catalog.filter((e) => !e.installed)];
}
