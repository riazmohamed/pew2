/**
 * An approved plan's progress for a conversation open in the GG Coder desktop
 * app. pew2's own GG Coder sessions get it from ACP `plan` updates; a window
 * mirrored from its JSONL has none, so the phone showed "Working · N steps" and
 * never "Step 3/10" (29 Oct). The window's agent marks a finished step with
 * `[DONE:n]` in its text (GG Coder's own contract: packages/ggcoder
 * utils/plan-steps.ts, mirrored here); the steps come from the plan file.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/** The prompt GG Coder sends when a plan is accepted (gg-app App.tsx acceptPlan). */
export const PLAN_APPROVED_PROMPT = "The plan has been approved.";

/** Headings that hold the plan's ordered steps (GG Coder's STEP_SECTION_HEADING). */
const STEP_SECTION_HEADING =
  /^#{2,3}\s+(?:implementation\s+steps|steps(?:\s+to\s+implement)?|tasks|to-?dos?|todo)\s*:?\s*$/im;

/** The numbered steps under the plan's steps heading; none without one (as GG Coder). */
export function extractPlanSteps(planContent: string): string[] {
  const match = planContent.match(STEP_SECTION_HEADING);
  if (!match || match.index === undefined) return [];
  const rest = planContent.slice(match.index + match[0].length);
  const next = rest.match(/^#{1,3}\s/m);
  const section = next?.index !== undefined ? rest.slice(0, next.index) : rest;
  const steps: string[] = [];
  for (const item of section.matchAll(/^(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm)) {
    const text = (item[2] ?? "")
      .trim()
      .replace(/\*{1,2}$/, "")
      .trim();
    if (text.length <= 5 || text.startsWith("`") || text.startsWith("/") || text.startsWith("-"))
      continue;
    steps.push(text);
  }
  return steps;
}

const DONE_MARKER = /\[DONE:(\d+)\]/g;

/** Step numbers a reply marks done. */
export function doneMarkers(text: string): number[] {
  return [...text.matchAll(DONE_MARKER)].map((m) => Number(m[1]));
}

/** The reply without its `[DONE:n]` markers, as GG Coder shows it. */
export function stripDoneMarkers(text: string): string {
  return text
    .replace(DONE_MARKER, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/ {2,}/g, " ");
}

export interface ApprovedPlan {
  planPath: string;
  steps: string[];
  done: Set<number>;
}

/**
 * The ACP `plan` update the phone already reads (chunks.ts): finished steps
 * completed, the first unfinished one in progress, the rest pending.
 */
export function planUpdate(plan: ApprovedPlan): Record<string, unknown> {
  let active = false;
  return {
    sessionUpdate: "plan",
    entries: plan.steps.map((content, index) => {
      let status = "pending";
      if (plan.done.has(index + 1)) status = "completed";
      else if (!active) {
        active = true;
        status = "in_progress";
      }
      return { content, priority: "medium", status };
    }),
  };
}

/**
 * Applies one mirrored update to the plan: markers in agent text tick steps
 * off and are taken out of what the phone shows. Returns the update to show and
 * whether the plan's progress changed.
 */
export function trackPlanUpdate(
  plan: ApprovedPlan,
  update: Record<string, unknown>,
): { update: Record<string, unknown>; changed: boolean } {
  if (update.sessionUpdate !== "agent_message_chunk") return { update, changed: false };
  const content = update.content as
    { type?: string; text?: string } | { type?: string; text?: string }[];
  const blocks = Array.isArray(content) ? content : [content];
  let changed = false;
  for (const block of blocks) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    for (const step of doneMarkers(block.text)) {
      if (step >= 1 && step <= plan.steps.length && !plan.done.has(step)) {
        plan.done.add(step);
        changed = true;
      }
    }
  }
  const strip = (block: { type?: string; text?: string }) =>
    block?.type === "text" && typeof block.text === "string" && /\[DONE:\d+\]/.test(block.text)
      ? { ...block, text: stripDoneMarkers(block.text) }
      : block;
  const shown = Array.isArray(content) ? content.map(strip) : strip(content);
  return { update: { ...update, content: shown }, changed };
}

/** The plan read from its file, or undefined when it has no steps section. */
export async function loadApprovedPlan(
  planPath: string,
  content?: string,
): Promise<ApprovedPlan | undefined> {
  const text = content ?? (await readFile(planPath, "utf8").catch(() => ""));
  const steps = extractPlanSteps(text);
  return steps.length > 0 ? { planPath, steps, done: new Set() } : undefined;
}

/** The conversation file's first user message and its parent, if any. */
async function conversationStart(
  file: string,
): Promise<{ text: string; firstUser?: string; parentSessionId?: string }> {
  const text = await readFile(file, "utf8").catch(() => "");
  let firstUser: string | undefined;
  let parentSessionId: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: {
      type?: string;
      parentSessionId?: unknown;
      message?: { role?: string; content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session" && typeof entry.parentSessionId === "string")
      parentSessionId = entry.parentSessionId;
    if (entry.message?.role !== "user") continue;
    const c = entry.message.content;
    firstUser =
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? (c as { text?: string }[]).map((b) => b.text ?? "").join("")
          : "";
    break;
  }
  return { text, firstUser, parentSessionId };
}

/**
 * Which file in `.gg/plans/` is the approved plan. The agent saves its own
 * working notes in the same folder while it implements (29 Oct), so "newest"
 * alone found notes, not the plan. Only files with a steps section count; the
 * one the conversation names wins (GG Coder's summary and prompts quote the
 * path), else the newest.
 */
async function approvedPlanFile(cwd: string, texts: string[]): Promise<ApprovedPlan | undefined> {
  const dir = path.join(cwd, ".gg", "plans");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".md"));
  const plans: { plan: ApprovedPlan; at: number; named: boolean }[] = [];
  const said = texts.join("\n");
  for (const name of names) {
    const file = path.join(dir, name);
    const plan = await loadApprovedPlan(file);
    if (!plan) continue;
    const at = (await stat(file).catch(() => undefined))?.mtimeMs ?? 0;
    plans.push({ plan, at, named: said.includes(`plans/${name}`) });
  }
  plans.sort((a, b) => Number(b.named) - Number(a.named) || b.at - a.at);
  return plans[0]?.plan;
}

/** How far back a compacted conversation is followed for its plan. */
const MAX_COMPACTIONS = 6;

/**
 * A conversation already under way on an accepted plan, found without having
 * seen the accept (pew2 restarted, or it was linked late): it began with GG
 * Coder's plan-approved prompt, or it is a compaction of one (GG Coder moves a
 * long run into a child conversation that starts with a summary, 29 Oct), found
 * through `parentSessionId`. Its plan is the newest file in the project's
 * `.gg/plans/`; steps marked done anywhere along the chain stay done.
 */
export async function recoverApprovedPlan(
  cwd: string,
  conversationFile: string,
  findFile?: (agentSessionId: string) => Promise<string | undefined>,
): Promise<ApprovedPlan | undefined> {
  const texts: string[] = [];
  let file: string | undefined = conversationFile;
  let approved = false;
  for (let hop = 0; file && hop <= MAX_COMPACTIONS; hop++) {
    const start = await conversationStart(file);
    texts.push(start.text);
    if (start.firstUser?.trim().startsWith(PLAN_APPROVED_PROMPT)) {
      approved = true;
      break;
    }
    if (!start.parentSessionId || !findFile) break;
    file = await findFile(start.parentSessionId);
  }
  if (!approved) return undefined;
  const plan = await approvedPlanFile(cwd, texts);
  if (!plan) return undefined;
  for (const text of texts)
    for (const step of doneMarkers(text))
      if (step >= 1 && step <= plan.steps.length) plan.done.add(step);
  return plan;
}
