/**
 * What the computer icon at the top of a conversation offers.
 *
 * Pure (no Expo), so it runs under `bun test`. `App.tsx` turns the answer into
 * a plain native Alert when there is a choice, and taps straight through when
 * there is not, exactly as before.
 */
export type DeskTarget = "chat" | "native" | "app";

/** The GG Coder desktop app, as the phone names it. */
export const APP_NAME = "GG Coder app";

export interface DeskAnnouncement {
  available: boolean;
  native?: string[];
  /** Providers the GG Coder desktop app can open. Absent: not available, or an older daemon. */
  app?: string[];
  /**
   * Windows pew2 opened on the computer that it can close, by conversation. A
   * GG Coder app window is `native` with `app: true`.
   */
  windows?: { agentSessionId: string; kind: "native" | "chat"; app?: boolean }[];
}

/** One button in the computer icon's menu. */
export type DeskAction = { kind: "open"; target: DeskTarget } | { kind: "close" };

/** What pew2 has open on the computer for this conversation. */
export function openWindows(
  desk: DeskAnnouncement | undefined,
  agentSessionId: string | undefined,
): { native: boolean; chat: boolean; app: boolean } {
  const mine = agentSessionId
    ? (desk?.windows ?? []).filter((w) => w.agentSessionId === agentSessionId)
    : [];
  return {
    native: mine.some((w) => w.kind === "native" && !w.app),
    chat: mine.some((w) => w.kind === "chat"),
    app: mine.some((w) => w.kind === "native" && w.app === true),
  };
}

/** Whether anything is open on the computer for this conversation. */
export function anyOpen(open: { native: boolean; chat: boolean; app?: boolean }): boolean {
  return open.native || open.chat || open.app === true;
}

/**
 * The computer icon's menu. Without the GG Coder app it is at most two actions
 * (Android's alert holds three buttons and one is Cancel); with it there can be
 * three, which `needsSheet` sends to a list instead of an alert.
 *
 * Nothing open: the places it can be opened, as before. Something open: close
 * it, plus the other places to open it (opening the same kind twice is not
 * offered).
 */
export function deskActions(
  desk: DeskAnnouncement | undefined,
  providerId: string | undefined,
  agentSessionId: string | undefined,
): DeskAction[] {
  const targets = deskTargets(desk, providerId);
  const open = openWindows(desk, agentSessionId);
  if (!anyOpen(open)) return targets.map((target) => ({ kind: "open" as const, target }));
  // Only one agent window at a time: with iTerm or the app holding it, the
  // other is not offered (the daemon would refuse it).
  const agentOpen = open.native || open.app;
  const others = targets.filter((target) => (target === "chat" ? !open.chat : !agentOpen));
  return [{ kind: "close" }, ...others.map((target) => ({ kind: "open" as const, target }))];
}

/** Android's alert holds three buttons, one of them Cancel: more actions need a list. */
export function needsSheet(actions: DeskAction[], platform: string): boolean {
  return platform === "android" && actions.length > 2;
}

/** The close button's label: says what goes. */
export function closeLabel(
  open: { native: boolean; chat: boolean; app?: boolean },
  agentName = "OG Coder",
): string {
  const count = [open.native, open.chat, open.app === true].filter(Boolean).length;
  if (count > 1) return "Close on computer";
  if (open.app) return `Close ${APP_NAME}`;
  return open.native ? `Close ${agentName}` : "Close pew2 chat";
}

/** Where a tap can open this conversation, in the order the chooser lists them. */
export function deskTargets(
  desk: DeskAnnouncement | undefined,
  providerId: string | undefined,
): DeskTarget[] {
  if (!desk?.available) return [];
  // An older daemon announces no `native`: only `pew2 chat`, as it always was.
  // Likewise no `app`: the GG Coder app is not offered.
  const targets: DeskTarget[] = [];
  if (providerId && desk.native?.includes(providerId)) targets.push("native");
  if (providerId && desk.app?.includes(providerId)) targets.push("app");
  targets.push("chat");
  return targets;
}

/** The chooser's button labels. */
export function deskTargetLabel(target: DeskTarget, agentName = "OG Coder"): string {
  if (target === "app") return `Open in ${APP_NAME}`;
  return target === "native" ? `Open in ${agentName}` : "Open in pew2 chat";
}
