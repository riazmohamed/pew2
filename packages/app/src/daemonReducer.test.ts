import { describe, expect, it } from "bun:test";
import { IDLE_ACTIVITY } from "./activity";
import { reduceMessage, type MessageScope } from "./daemonReducer";
import type { State } from "./daemonState";

function start(): State {
  return {
    status: "online",
    providers: [],
    turns: [],
    sessions: [],
    configOptions: [],
    commands: [],
    busy: false,
    activity: IDLE_ACTIVITY,
    loadingSessions: false,
    heard: false,
    loadingSession: false,
    projects: {},
    projectPath: {},
    workspaceNonce: 0,
    liveSessionIds: [],
  };
}

function scope(pending: string[]): MessageScope {
  return {
    sessionRef: { current: undefined },
    pendingCapabilities: { current: new Set(pending) },
    claimsScreen: false,
    adoptedRequestId: undefined,
    completedTurn: undefined,
    now: 0,
  };
}

const agents = [
  { id: "claude", name: "Claude Code", available: true },
  { id: "codex", name: "Codex", available: true },
];

describe("heard: the computer has answered, not merely connected", () => {
  it("is false while any agent asked about has not answered", () => {
    // The socket is open and the agent list is in, but the sessions are not:
    // home said "No sessions yet" here and moved Pew to the middle.
    const pending = ["claude", "codex"];
    let state = reduceMessage(start(), { t: "providers", providers: agents }, scope(pending));
    expect(state.heard).toBe(false);
    pending.shift();
    state = reduceMessage(
      state,
      { t: "provider.capabilities", providerId: "claude", sessions: [] },
      scope(pending),
    );
    expect(state.heard).toBe(false);
  });

  it("turns true with the last answer, and stays true", () => {
    let state = reduceMessage(
      start(),
      { t: "provider.capabilities", providerId: "codex", sessions: [] },
      scope([]),
    );
    expect(state.heard).toBe(true);
    // A reconnect's agent list, with something asked again, does not undo it.
    state = reduceMessage(state, { t: "providers", providers: agents }, scope(["claude"]));
    expect(state.heard).toBe(true);
  });

  it("is true at once when there is no agent to wait on", () => {
    const state = reduceMessage(start(), { t: "providers", providers: [] }, scope([]));
    expect(state.heard).toBe(true);
  });
});
