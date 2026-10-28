import { expect, test } from "bun:test";
import { RECENT_STEPS, workProgress } from "./workProgress";
import type { ToolRun } from "./activity";

const tool = (id: string, status: ToolRun["status"], title = `Step ${id}`): ToolRun => ({
  id,
  title,
  kind: "other",
  status,
});

test("nothing to follow: no plan in progress and no turn running", () => {
  expect(workProgress(undefined, [], false)).toBeUndefined();
  expect(workProgress([{ content: "a", status: "completed" }], [], false)).toBe(undefined);
  expect(workProgress(undefined, [tool("1", "completed")], false)).toBeUndefined();
});

test("a running turn streams its newest steps, with the running one as now", () => {
  const tools = [1, 2, 3, 4, 5, 6].map((n) => tool(String(n), n < 6 ? "completed" : "in_progress"));
  const work = workProgress(undefined, tools, true)!;
  expect(work.summary).toBe("Working · 6 steps");
  expect(work.now).toBe("Step 6");
  expect(work.steps.map((s) => s.id)).toEqual(["3", "4", "5", "6"]);
  expect(work.steps).toHaveLength(RECENT_STEPS);
  expect(work.earlier).toBe(2);
});

test("a plan in progress leads, and its current entry is now", () => {
  const plan = [
    { content: "Read the code", status: "completed" as const },
    { content: "Fix the bug", status: "in_progress" as const },
    { content: "Gone", status: "cancelled" as const },
    { content: "Run tests", status: "pending" as const },
  ];
  const work = workProgress(plan, [tool("1", "in_progress", "Editing a.ts")], true)!;
  expect(work.summary).toBe("Step 2/3");
  expect(work.spoken).toBe("Step 2 of 3");
  expect(work.now).toBe("Fix the bug");
  expect(work.plan.map((e) => e.content)).toEqual(["Read the code", "Fix the bug", "Run tests"]);
  expect(work.steps.map((s) => s.title)).toEqual(["Editing a.ts"]);
});

test("between turns a plan still in progress shows, without old steps", () => {
  const plan = [{ content: "Next", status: "pending" as const }];
  const work = workProgress(plan, [tool("1", "completed")], false)!;
  expect(work.steps).toEqual([]);
  expect(work.now).toBeUndefined();
});

test("between steps of a plan: done of total", () => {
  const plan = [
    { content: "One", status: "completed" as const },
    { content: "Two", status: "pending" as const },
    { content: "Three", status: "pending" as const },
  ];
  const work = workProgress(plan, [], false)!;
  expect(work.summary).toBe("Plan 1/3");
  expect(work.spoken).toBe("Plan, 1 of 3 done");
});
