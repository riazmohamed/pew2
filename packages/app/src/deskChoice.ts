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
  /** Windows pew2 opened on the computer that it can close, by conversation. */
  windows?: { agentSessionId: string; kind: "native" | "chat" }[];
}

/** One button in the computer icon's menu. */
export type DeskAction = { kind: "open"; target: DeskTarget } | { kind: "close" };

/** What pew2 has open on the computer for this conversation. */
export function openWindows(
  desk: DeskAnnouncement | undefined,
  agentSessionId: string | undefined,
): { native: boolean; chat: boolean } {
  const mine = agentSessionId ? (desk?.windows ?? []).filter((w) => w.agentSessionId === agentSessionId) : [];
  return { native: mine.some((w) => w.kind === "native"), chat: mine.some((w) => w.kind === "chat") };
}

/**
 * The computer icon's menu, at most two actions: Android's alert holds three
 * buttons and one is Cancel.
 *
 * Nothing open: the places it can be opened, as before. Something open: close
 * it, plus the other place to open it if there is one (opening the same kind
 * twice is not offered).
 */
export function deskActions(
  desk: DeskAnnouncement | undefined,
  providerId: string | undefined,
  agentSessionId: string | undefined,
): DeskAction[] {
  const targets = deskTargets(desk, providerId);
  const open = openWindows(desk, agentSessionId);
  if (!open.native && !open.chat) return targets.map((target) => ({ kind: "open" as const, target }));
  const other = targets.find((target) => !(target === "native" ? open.native : open.chat));
  return [{ kind: "close" }, ...(other ? [{ kind: "open" as const, target: other }] : [])];
}

/** The close button's label: says what goes. */
export function closeLabel(open: { native: boolean; chat: boolean }, agentName = "OG Coder"): string {
  if (open.native && open.chat) return "Close on computer";
  return open.native ? `Close ${agentName}` : "Close pew2 chat";
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
