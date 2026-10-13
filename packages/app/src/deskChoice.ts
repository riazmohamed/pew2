/**
 * What the computer icon at the top of a conversation offers.
 *
 * Pure (no Expo), so it runs under `bun test`. `App.tsx` turns the answer into
 * a plain native Alert when there is a choice, and taps straight through when
 * there is not, exactly as before.
 */
export type DeskTarget = "chat" | "native";

export interface DeskAnnouncement {
  available: boolean;
  native?: string[];
}

/** Where a tap can open this conversation, in the order the chooser lists them. */
export function deskTargets(desk: DeskAnnouncement | undefined, providerId: string | undefined): DeskTarget[] {
  if (!desk?.available) return [];
  // An older daemon announces no `native`: only `pew2 chat`, as it always was.
  if (providerId && desk.native?.includes(providerId)) return ["native", "chat"];
  return ["chat"];
}

/** The chooser's button labels. */
export function deskTargetLabel(target: DeskTarget, agentName = "OG Coder"): string {
  return target === "native" ? `Open in ${agentName}` : "Open in pew2 chat";
}
