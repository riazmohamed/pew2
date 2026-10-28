/**
 * A call you can put away: the rules behind minimising the call screen, the
 * banner that stands in for it over the chat, and Android's back button.
 *
 * Pure (no React, no Expo) so `bun test` can hold it. The call itself lives in
 * `useVoice`, which never unmounts with the screen, so hiding the screen is
 * only a view decision: audio, GPT-Live and every timer carry on.
 */
import type { CallPhase, CallState } from "./voiceCall";
import type { LaneView } from "./voiceBoard";
import type { Status } from "./daemonTypes";

/** A call still in progress: the only phases that can be minimised. */
export function canMinimise(phase: CallPhase): boolean {
  return phase === "connecting" || phase === "live" || phase === "ending";
}

/** The full call screen is up: a call exists and it is not put away. */
export function callScreenVisible(phase: CallPhase, minimised: boolean): boolean {
  if (phase === "idle") return false;
  return !(minimised && canMinimise(phase));
}

/** The banner over the chat: a minimised call still in progress. */
export function callBarVisible(phase: CallPhase, minimised: boolean): boolean {
  return minimised && canMinimise(phase);
}

/**
 * What a phase change does to a minimised call. A failure comes back up (its
 * reason and Retry are on the screen); a call that ended while put away is
 * cleared, so no summary rises over the chat the user went back to.
 */
export function minimiseOnPhase(
  minimised: boolean,
  phase: CallPhase,
): { minimised: boolean; dismiss: boolean } {
  if (!minimised) return { minimised: false, dismiss: false };
  if (phase === "ended") return { minimised: false, dismiss: true };
  if (phase === "idle" || phase === "failed") return { minimised: false, dismiss: false };
  return { minimised: true, dismiss: false };
}

/** The daemon link is down during a call: shown as "Reconnecting…" until it is back. */
export function callReconnecting(phase: CallPhase, status: Status): boolean {
  return canMinimise(phase) && status !== "online";
}

/**
 * The lane worth a glance in the banner: the one Pew is on (spotlight), else
 * the first one working. Undefined when nothing is busy.
 */
export function busiestLane(lanes: readonly LaneView[]): LaneView | undefined {
  return (
    lanes.find((lane) => lane.spotlight) ??
    lanes.find((lane) => lane.mood === "working" || lane.mood === "thinking")
  );
}

export interface CallBarLine {
  status: string;
  lane?: { sessionId: string; folder: string; step?: string };
}

/** The banner's one line: what the call is doing, and the busiest project's current step. */
export function callBarLine(
  call: Pick<CallState, "phase" | "pewAudio" | "userSpeaking" | "muted">,
  reconnecting: boolean,
  lanes: readonly LaneView[],
): CallBarLine {
  const status = reconnecting
    ? "Reconnecting…"
    : call.phase === "connecting"
      ? "Connecting…"
      : call.phase === "ending"
        ? "Ending call…"
        : call.pewAudio
          ? "Pew speaking"
          : call.muted
            ? "Muted"
            : "Listening";
  const lane = busiestLane(lanes);
  if (!lane) return { status };
  const step = lane.current?.text.trim() || lane.status.word || undefined;
  return { status, lane: { sessionId: lane.sessionId, folder: lane.folder, step } };
}

export type BackAction = "minimise" | "closeSheet" | "holdSheet" | "closeDrawer" | "system";

/**
 * Android back, in priority order: the expanded call screen minimises (never
 * hangs up), then the top sheet closes (one with no way to close stays put and
 * eats the press), then the drawer closes, else the system default.
 */
export function backAction(state: {
  callExpanded: boolean;
  sheet?: { closable: boolean };
  drawerOpen: boolean;
}): BackAction {
  if (state.callExpanded) return "minimise";
  if (state.sheet) return state.sheet.closable ? "closeSheet" : "holdSheet";
  if (state.drawerOpen) return "closeDrawer";
  return "system";
}

/**
 * A chat that started working on this call since the last look: the call
 * steps aside for it (the screen minimises and that chat opens, so the reply
 * is read as it streams). Only a lane that was not working before counts, so
 * a call the user brought back up stays up until the next piece of work.
 */
export function newlyWorking(
  before: ReadonlySet<string>,
  lanes: readonly LaneView[],
): { sessionId: string; working: Set<string> } | { sessionId?: undefined; working: Set<string> } {
  const working = new Set(
    lanes
      .filter((lane) => lane.mood === "working" || lane.mood === "thinking")
      .map((lane) => lane.sessionId),
  );
  for (const id of working) if (!before.has(id)) return { sessionId: id, working };
  return { working };
}
