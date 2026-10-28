/**
 * What the agent is working through right now, for the work card above the
 * composer and the call's Live panel: the plan with its ticks, and the last
 * few tool steps as they stream. Pure, so `bun test` holds the rules.
 */
import type { PlanEntry } from "./chunks";
import type { ToolRun, ToolStatus } from "./activity";

/** Steps shown in the list: the newest few, oldest first. */
export const RECENT_STEPS = 4;

export interface WorkStep {
  id: string;
  title: string;
  status: ToolStatus;
}

export interface WorkProgress {
  /**
   * One line: "Step 3/5" while a plan entry is in progress (its place in the
   * plan), "Plan 2/5" (done of total) between steps, or "Working · 7 steps"
   * with no plan.
   */
  summary: string;
  /** The summary for a screen reader: "Plan, 2 of 5 done". */
  spoken: string;
  /** What is happening now: the plan entry in progress, else the running step. */
  now?: string;
  /** The plan, cancelled entries left out. Empty when the agent sent none. */
  plan: PlanEntry[];
  /** The newest steps (tool runs), oldest first. */
  steps: WorkStep[];
  /** Steps not in `steps` (older ones), for a "+3 earlier" line. */
  earlier: number;
}

const running = (status: ToolStatus) => status === "pending" || status === "in_progress";

/**
 * The progress to show, or undefined when there is nothing to follow: no plan
 * in progress and no turn running. A finished plan with the turn over is the
 * receipt's job, as before.
 */
export function workProgress(
  plan: readonly PlanEntry[] | undefined,
  tools: readonly ToolRun[],
  working: boolean,
): WorkProgress | undefined {
  const live = (plan ?? []).filter((entry) => entry.status !== "cancelled");
  const done = live.filter((entry) => entry.status === "completed").length;
  const planOpen = live.length > 0 && done < live.length;
  if (!planOpen && !(working && tools.length > 0)) return undefined;

  const shown = working ? tools : [];
  const steps = shown.slice(-RECENT_STEPS).map((tool) => ({
    id: tool.id,
    title: tool.title.trim() || "Working",
    status: tool.status,
  }));
  const stepIndex = planOpen ? live.findIndex((entry) => entry.status === "in_progress") : -1;
  const current =
    live[stepIndex]?.content ?? [...shown].reverse().find((tool) => running(tool.status))?.title;
  const count = shown.length;
  const summary = planOpen
    ? stepIndex >= 0
      ? `Step ${stepIndex + 1}/${live.length}`
      : `Plan ${done}/${live.length}`
    : `Working · ${count} step${count === 1 ? "" : "s"}`;
  const spoken = planOpen
    ? stepIndex >= 0
      ? `Step ${stepIndex + 1} of ${live.length}`
      : `Plan, ${done} of ${live.length} done`
    : summary;
  return {
    summary,
    spoken,
    ...(current ? { now: current.trim() } : {}),
    plan: planOpen ? live : [],
    steps,
    earlier: Math.max(0, shown.length - steps.length),
  };
}
