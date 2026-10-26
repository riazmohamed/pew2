import { expect, test } from "bun:test";
import { IDLE_BOARD, foldBoard, onProject, type BoardSession } from "./voiceBoard";

const T0 = 1_000_000;
const sess = (
  id: string,
  folder: string,
  touchedAt: number,
  agentName = "OG Coder",
): BoardSession => ({
  sessionId: id,
  folder,
  agentName,
  status: "working",
  since: T0,
  touchedAt,
  lines: [],
});
const board = (sessions: BoardSession[]) =>
  foldBoard(IDLE_BOARD, { t: "voice.board", callId: "c", sessions }, T0);
const noCall = { tools: [], inbox: [] };

test("the call is on the project Pew last worked with", () => {
  const state = board([
    sess("a", "billing", T0 + 5),
    sess("b", "viral-kid", T0 + 9, "Claude Code"),
  ]);
  expect(onProject(state, noCall)).toEqual({ folder: "viral-kid", agentName: "Claude Code" });
});

test("a tool in flight on a chat puts the call on that chat", () => {
  const state = board([sess("a", "billing", T0 + 5), sess("b", "viral-kid", T0 + 9)]);
  const call = {
    inbox: [],
    tools: [
      {
        toolCallId: "t",
        name: "tell_agent",
        arguments: JSON.stringify({ session_id: "a", text: "hi" }),
        requestId: "r",
      },
    ],
  };
  expect(onProject(state, call)?.folder).toBe("billing");
});

test("before Pew touches a chat, the place the call came from; with neither, nothing", () => {
  const state = board([sess("a", "billing", 0)]);
  expect(onProject(state, noCall, { folder: "pew2", agentName: "OG Coder" })).toEqual({
    folder: "pew2",
    agentName: "OG Coder",
  });
  expect(onProject(state, noCall)).toBeUndefined();
});
