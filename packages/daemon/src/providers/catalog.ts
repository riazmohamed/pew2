/**
 * The phone's Agents settings: every agent this machine knows, on or off.
 *
 * Pure, so the rules are tested without a daemon. GG Goals has no manifest of
 * its own (it is synthesised from ggcoder), so it is on only while ggcoder is
 * and turning it on turns ggcoder on with it.
 */
import { isAvailable, unavailableReason, type LoadedProvider } from "./registry.js";

export const GG_CODER_ID = "ggcoder";
export const GOALS_ID = "gg-goals";

export interface CatalogEntry {
  id: string;
  name: string;
  enabled: boolean;
  installed: boolean;
  reason?: string;
}

/** Whether an agent may run, with GG Goals following ggcoder. */
export function catalogEnabled(id: string, disabled: ReadonlySet<string>): boolean {
  if (disabled.has(id)) return false;
  return id !== GOALS_ID || !disabled.has(GG_CODER_ID);
}

export function catalogEntries(
  providers: readonly LoadedProvider[],
  disabled: ReadonlySet<string>,
  includeExperimental: boolean,
): CatalogEntry[] {
  return providers
    .filter((p) => !p.manifest.pew.experimental || includeExperimental)
    .map((p) => {
      const reason = isAvailable(p) ? undefined : unavailableReason(p);
      return {
        id: p.manifest.id,
        name: p.manifest.name,
        enabled: catalogEnabled(p.manifest.id, disabled),
        installed: !p.commandMissing,
        ...(reason ? { reason } : {}),
      };
    });
}

/**
 * The ids to write for one switch. Turning GG Goals on needs ggcoder on, so
 * both go; turning ggcoder off hides GG Goals through `catalogEnabled` and
 * leaves its own entry alone, so turning ggcoder back on restores it as it was.
 */
export function idsToToggle(id: string, enabled: boolean): string[] {
  return id === GOALS_ID && enabled ? [GOALS_ID, GG_CODER_ID] : [id];
}
