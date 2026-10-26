import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession } from "./connect";
import {
  assetDirFor,
  hydrateGgCoderMessageCounts,
  loadGgCoderDisplayHistory,
  messageDisplayUpdates,
} from "./ggcoder-history";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("counts the unopened GG Coder lineage exactly as ACP replay renders it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pew2-gg-history-"));
  roots.push(root);
  const cwd = "/Users/test/my-project";
  const directory = path.join(root, "Users_test_my-project");
  await mkdir(directory, { recursive: true });
  const sessionId = "12345678-1234-1234-1234-123456789abc";
  const entries = [
    { type: "session", id: sessionId, cwd, leafId: "a3" },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Question" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      message: { role: "assistant", content: [{ type: "text", text: "Working" }] },
    },
    {
      type: "message",
      id: "tool",
      parentId: "a1",
      message: { role: "tool", content: [{ type: "tool_result", content: "done" }] },
    },
    {
      type: "message",
      id: "a2",
      parentId: "tool",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    },
    {
      type: "message",
      id: "abandoned",
      parentId: "u1",
      message: { role: "assistant", content: "Not on the active branch" },
    },
    { type: "message", id: "u2", parentId: "a2", message: { role: "user", content: "Thanks" } },
    {
      type: "message",
      id: "a3",
      parentId: "u2",
      message: { role: "assistant", content: "Any time" },
    },
  ];
  await writeFile(
    path.join(directory, `2026-07-31T12-00-00-000Z_${sessionId.slice(0, 8)}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const sessions: AgentSession[] = [{ sessionId, cwd, title: "Stored session" }];

  await hydrateGgCoderMessageCounts(sessions, root);

  // a1 and a2 coalesce because invisible tool updates do not create a row.
  expect(sessions[0]!.messageCount).toBe(4);
});

test("loads a compacted GG Coder chain locally without the child summary or overlap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pew2-gg-display-"));
  roots.push(root);
  const cwd = "/Users/test/my-project";
  const directory = path.join(root, "Users_test_my-project");
  await mkdir(directory, { recursive: true });
  const parentId = "aaaaaaaa-1234-1234-1234-123456789abc";
  const childId = "bbbbbbbb-1234-1234-1234-123456789abc";
  const conversationId = parentId;
  const parentMessages = [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "First" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      message: { role: "assistant", content: "Answer" },
    },
  ];
  await writeFile(
    path.join(directory, `parent_${parentId.slice(0, 8)}.jsonl`),
    [{ type: "session", id: parentId, conversationId, cwd, leafId: "a1" }, ...parentMessages]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  await writeFile(
    path.join(directory, `child_${childId.slice(0, 8)}.jsonl`),
    [
      {
        type: "session",
        id: childId,
        conversationId,
        parentSessionId: parentId,
        cwd,
        leafId: "a2",
      },
      {
        type: "message",
        id: "summary",
        parentId: null,
        message: { role: "user", content: "[Previous conversation summary]\nOld context" },
      },
      {
        type: "message",
        id: "u1-copy",
        parentId: "summary",
        message: { role: "user", content: "First" },
      },
      {
        type: "message",
        id: "a1-copy",
        parentId: "u1-copy",
        message: { role: "assistant", content: "Answer" },
      },
      {
        type: "message",
        id: "u2",
        parentId: "a1-copy",
        message: { role: "user", content: "Second" },
      },
      {
        type: "message",
        id: "a2",
        parentId: "u2",
        message: { role: "assistant", content: "Done" },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );

  const updates = await loadGgCoderDisplayHistory(childId, cwd, root);
  expect(updates).toEqual([
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "First" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" } },
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Second" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } },
  ]);
});

test("a picture OG Coder stored beside the conversation is read back from its asset folder", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pew2-assets-"));
  const file = path.join(dir, "2026-10-14T08-29-49-779Z_43c774b7.jsonl");
  const sha = "b".repeat(64);
  await mkdir(assetDirFor(file), { recursive: true });
  await writeFile(path.join(assetDirFor(file), sha), Buffer.from("PNGDATA"));
  const message = {
    role: "user",
    content: [
      { type: "text", text: "look" },
      { type: "image", mediaType: "image/png", data: `gg-session-asset:v1:${sha}` },
      { type: "image", mediaType: "image/png", data: `gg-session-asset:v1:${"c".repeat(64)}` },
    ],
  };
  const updates = messageDisplayUpdates(message, { assetDirs: [assetDirFor(file)] });
  const content = (updates[0] as { content: unknown[] }).content;
  // The one on disk comes back as bytes; the missing one is left out, not broken.
  expect(content).toEqual([
    { type: "text", text: "look" },
    { type: "image", mimeType: "image/png", data: Buffer.from("PNGDATA").toString("base64") },
  ]);
  expect(assetDirFor(file)).toBe(path.join(dir, "2026-10-14T08-29-49-779Z_43c774b7.assets"));
});

test("replays Ken's persisted Autopilot verdicts where they were written", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pew2-gg-ken-"));
  roots.push(root);
  const cwd = "/Users/test/ken-project";
  const directory = path.join(root, "Users_test_ken-project");
  await mkdir(directory, { recursive: true });
  const id = "cccccccc-1234-1234-1234-123456789abc";
  const marker = (
    phase: string,
    afterMessageCount: number,
    extra: Record<string, string> = {},
  ) => ({
    type: "custom",
    kind: "autopilot_marker",
    parentId: null,
    data: { version: 1, phase, afterMessageCount, ...extra },
  });
  const hidden = { source: "runtime", kind: "automation", visibility: "hidden" };
  await writeFile(
    path.join(directory, `s_${id.slice(0, 8)}.jsonl`),
    [
      { type: "session", id, cwd, leafId: "a2" },
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Build it" } },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        message: { role: "assistant", content: "Built" },
      },
      marker("prompted", 2, { body: "Add a test" }),
      // Same payload re-persisted by an old path: kept once.
      marker("prompted", 2, { body: "Add a test" }),
      {
        type: "message",
        id: "u2",
        parentId: "a1",
        message: { role: "user", content: "[injected]", provenance: hidden },
      },
      {
        type: "message",
        id: "a2",
        parentId: "u2",
        message: { role: "assistant", content: "Tested" },
      },
      // Anchor past what was on disk when written: clamped to 4.
      marker("done", 9),
      // A desktop-only phase name maps onto the wire's.
      marker("plan_approved", 4, { reason: "solid" }),
      // Unknown phases are ignored.
      marker("mystery", 1),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );

  const updates = await loadGgCoderDisplayHistory(id, cwd, root);
  expect(updates).toEqual([
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Build it" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Built" } },
    { kind: "autopilot", phase: "prompted", body: "Add a test" },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Tested" } },
    { kind: "autopilot", phase: "done" },
    { kind: "autopilot", phase: "plan_accepted", reason: "solid" },
  ]);
});
