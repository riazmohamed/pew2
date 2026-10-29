import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  extractPlanSteps,
  planUpdate,
  recoverApprovedPlan,
  stripDoneMarkers,
  trackPlanUpdate,
  type ApprovedPlan,
} from "./app-plan";

const PLAN = `# Check the plan

## Goal
1. Not a step, just prose under Goal

## Steps
1. Extract every phase into a checklist
2. **Compare the server with this machine**
3) Run the tests here and on the server
   1. an indented sub-item, skipped

## Notes
4. Not a step either
`;

test("steps come only from the Steps section, as GG Coder reads them", () => {
  expect(extractPlanSteps(PLAN)).toEqual([
    "Extract every phase into a checklist",
    "Compare the server with this machine",
    "Run the tests here and on the server",
  ]);
  expect(extractPlanSteps("# A plan\n\n1. One thing to do\n2. Another thing")).toEqual([]);
});

test("the plan update: done steps completed, the next one in progress", () => {
  const plan: ApprovedPlan = {
    planPath: "/p.md",
    steps: ["one step", "two step", "three step"],
    done: new Set([1]),
  };
  expect(planUpdate(plan)).toEqual({
    sessionUpdate: "plan",
    entries: [
      { content: "one step", priority: "medium", status: "completed" },
      { content: "two step", priority: "medium", status: "in_progress" },
      { content: "three step", priority: "medium", status: "pending" },
    ],
  });
});

test("[DONE:n] ticks steps off once and is taken out of the shown text", () => {
  const plan: ApprovedPlan = { planPath: "/p.md", steps: ["a step", "b step"], done: new Set() };
  const first = trackPlanUpdate(plan, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Step 1 is finished. [DONE:1] Moving on." },
  });
  expect(first.changed).toBe(true);
  expect([...plan.done]).toEqual([1]);
  expect((first.update.content as { text: string }).text).not.toContain("[DONE");
  const again = trackPlanUpdate(plan, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "[DONE:1] [DONE:9]" },
  });
  expect(again.changed).toBe(false);
  const tool = { sessionUpdate: "tool_call", title: "bash [DONE:2]" };
  expect(trackPlanUpdate(plan, tool)).toEqual({ update: tool, changed: false });
  expect(stripDoneMarkers("done [DONE:3]  now")).toBe("done now");
});

test("a conversation that began with the accept prompt recovers its plan and progress", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "app-plan-"));
  await mkdir(path.join(cwd, ".gg", "plans"), { recursive: true });
  await writeFile(path.join(cwd, ".gg", "plans", "check.md"), PLAN);
  const conv = path.join(cwd, "conv.jsonl");
  const lines = [
    { type: "session", id: "x" },
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "The plan has been approved. Implement it now." }],
      },
    },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Done with one. [DONE:1]" }] },
    },
  ];
  await writeFile(conv, lines.map((l) => JSON.stringify(l)).join("\n"));
  const plan = await recoverApprovedPlan(cwd, conv);
  expect(plan?.steps.length).toBe(3);
  expect([...(plan?.done ?? [])]).toEqual([1]);

  const other = path.join(cwd, "other.jsonl");
  await writeFile(
    other,
    JSON.stringify({ type: "message", message: { role: "user", content: "Hi" } }),
  );
  expect(await recoverApprovedPlan(cwd, other)).toBeUndefined();
});

test("a compacted conversation keeps its plan and the steps done before compaction", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "app-plan-c-"));
  await mkdir(path.join(cwd, ".gg", "plans"), { recursive: true });
  await writeFile(path.join(cwd, ".gg", "plans", "check.md"), PLAN);
  const parent = path.join(cwd, "parent.jsonl");
  const child = path.join(cwd, "child.jsonl");
  const write = (file: string, lines: unknown[]) =>
    writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  await write(parent, [
    { type: "session", id: "parent-id" },
    { type: "message", message: { role: "user", content: "The plan has been approved. Go." } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "[DONE:1]" }] },
    },
  ]);
  await write(child, [
    { type: "session", id: "child-id", parentSessionId: "parent-id" },
    { type: "message", message: { role: "user", content: "[Previous conversation summary] ..." } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "[DONE:3]" }] },
    },
  ]);
  const find = async (id: string) => (id === "parent-id" ? parent : undefined);
  const plan = await recoverApprovedPlan(cwd, child, find);
  expect([...(plan?.done ?? [])].sort()).toEqual([1, 3]);
  expect(await recoverApprovedPlan(cwd, child)).toBeUndefined();
});

test("the plan is the named file with steps, not the agent's newer notes", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "app-plan-n-"));
  const plans = path.join(cwd, ".gg", "plans");
  await mkdir(plans, { recursive: true });
  await writeFile(path.join(plans, "check-the-plan.md"), PLAN);
  await writeFile(path.join(plans, "older-plan.md"), "## Steps\n1. Some other old step\n");
  // Written later by the agent while implementing: no steps section.
  await writeFile(
    path.join(plans, "plan-check-summary.md"),
    "# Summary\n\n1. Not a plan step at all\n",
  );
  const conv = path.join(cwd, "conv.jsonl");
  await writeFile(
    conv,
    [
      { type: "session", id: "x" },
      { type: "message", message: { role: "user", content: "The plan has been approved. Do it." } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Following .gg/plans/check-the-plan.md" }],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n"),
  );
  const plan = await recoverApprovedPlan(cwd, conv);
  expect(plan?.planPath.endsWith("check-the-plan.md")).toBe(true);
  expect(plan?.steps.length).toBe(3);
});
