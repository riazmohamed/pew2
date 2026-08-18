/**
 * Closing the app must not read as losing every conversation.
 *
 * The bug this covers was reported as data loss — "I restarted and all my
 * conversations are gone" — when nothing had been lost: the list lived only in
 * React state, so a cold start began empty and stayed empty until a daemon
 * answered. The rules below are what make a restored row indistinguishable from
 * one the agent has just listed, which is the property that lets the rest of the
 * app stay unaware this cache exists.
 */
import { test, expect } from "bun:test";
import {
  fromCachedSessions,
  sessionCacheKey,
  toCachedSessions,
  SESSION_CACHE_LIMIT,
} from "./sessionCache";
import { isAgentSessionStub, mergeAgentSessions, needsResume } from "./agentHistory";
import type { Session } from "./useDaemon";

const NOW = 1_700_000_000_000;

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "live-1",
    providerId: "ggcoder",
    title: "Fix the drawer",
    startedAt: NOW,
    turns: [],
    configOptions: [],
    agentSessionId: "agent-1",
    cwd: "/repo/pew2",
    ...overrides,
  };
}

/** What the app does across a restart: store, then read back. */
function roundTrip(sessions: Session[]): Session[] {
  return fromCachedSessions({ version: 1, sessions: toCachedSessions(sessions) });
}

test("a conversation survives the app being closed", () => {
  const [restored] = roundTrip([session()]);

  expect(restored?.title).toBe("Fix the drawer");
  expect(restored?.providerId).toBe("ggcoder");
  expect(restored?.cwd).toBe("/repo/pew2");
  expect(restored?.agentSessionId).toBe("agent-1");
});

test("a restored conversation can be reopened, because it is a stub", () => {
  const [restored] = roundTrip([session()]);

  // Both together are the point: the id says the turns are on the agent's
  // disk, and `needsResume` is what makes opening the row fetch them.
  expect(isAgentSessionStub(restored!.id)).toBe(true);
  expect(needsResume(restored!, new Set())).toBe(true);
});

test("a session the agent cannot reopen is not remembered at all", () => {
  // No `agentSessionId`: its id was assigned by a daemon process that has since
  // exited, so restoring it would put a row in the drawer that answers "Unknown
  // session" on the next prompt.
  expect(toCachedSessions([session({ agentSessionId: undefined })])).toEqual([]);
});

test("turns are never stored", () => {
  const withTurns = session({
    turns: [{ id: "t0", role: "user", text: "a secret prompt" }],
  });

  expect(JSON.stringify(toCachedSessions([withTurns]))).not.toContain("secret");
  expect(roundTrip([withTurns])[0]?.turns).toEqual([]);
});

test("a conversation that was mid-turn does not come back busy", () => {
  // The agent that was working died with the process that ran it, so a restored
  // spinner is one nothing can ever stop.
  expect(roundTrip([session({ busy: true })])[0]?.busy).toBeUndefined();
});

test("an unread conversation is still marked unread", () => {
  expect(roundTrip([session({ unread: true })])[0]?.unread).toBe(true);
});

test("selectors are not restored, so a stale model is never shown as current", () => {
  const configured = session({
    configOptions: [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "opus" },
    ],
  });

  expect(roundTrip([configured])[0]?.configOptions).toEqual([]);
});

test("the newest conversations are kept when there are more than the limit", () => {
  const many = Array.from({ length: SESSION_CACHE_LIMIT + 20 }, (_, i) =>
    session({ id: `live-${i}`, agentSessionId: `agent-${i}`, startedAt: NOW + i }),
  );

  const cached = toCachedSessions(many);
  expect(cached).toHaveLength(SESSION_CACHE_LIMIT);
  expect(cached[0]?.agentSessionId).toBe(`agent-${SESSION_CACHE_LIMIT + 19}`);
});

test("restored conversations are not listed twice when the agent lists them too", () => {
  const restored = roundTrip([session()]);

  const merged = mergeAgentSessions(
    restored,
    "ggcoder",
    [{ sessionId: "agent-1", cwd: "/repo/pew2", title: "Fix the drawer" }],
    true,
  );

  expect(merged).toHaveLength(1);
});

test("a malformed record is skipped without taking the rest of the file with it", () => {
  const restored = fromCachedSessions({
    version: 1,
    sessions: [
      { id: "agent:ggcoder:a", providerId: "ggcoder", startedAt: NOW, agentSessionId: "a", title: "Kept" },
      { id: "agent:ggcoder:b", providerId: "ggcoder", startedAt: "not a number", agentSessionId: "b" },
      null,
      { providerId: "ggcoder", startedAt: NOW, agentSessionId: "c" },
    ],
  });

  expect(restored.map((s) => s.title)).toEqual(["Kept"]);
});

test("a file from another era is an empty drawer, not a crash", () => {
  expect(fromCachedSessions(undefined)).toEqual([]);
  expect(fromCachedSessions({})).toEqual([]);
  expect(fromCachedSessions({ version: 1, sessions: "nonsense" })).toEqual([]);
});

test("an untitled conversation still gets a row", () => {
  const restored = fromCachedSessions({
    version: 1,
    sessions: [{ id: "agent:ggcoder:a", providerId: "ggcoder", startedAt: NOW, agentSessionId: "a", title: "   " }],
  });

  expect(restored[0]?.title).toBe("Untitled conversation");
});

test("streaming a reply does not ask for a rewrite", () => {
  const before = session();
  // What a streamed chunk does: appends to the open session's turns, which the
  // cache does not store. Writing the file for this would be hundreds of
  // identical writes per answered prompt.
  const after = session({ turns: [{ id: "t0", role: "agent", text: "working..." }] });

  expect(sessionCacheKey([after])).toBe(sessionCacheKey([before]));
});

test("a renamed conversation does ask for a rewrite", () => {
  expect(sessionCacheKey([session({ title: "Renamed" })])).not.toBe(
    sessionCacheKey([session()]),
  );
});

test("every stored field moves the key, so none can change unwritten", () => {
  // The key is hand-built, and the same shape of key on the provider cache was
  // silently missing two fields: a rename changed what would be stored and not
  // the key, so the write never fired and the phone restored the old name.
  // Here the failure would be quieter still — a title or a message count that
  // is right on screen and wrong after a restart.
  //
  // One mutation per field `toCachedSessions` writes. The count is asserted
  // below, so adding a field to the cache without covering it fails here
  // rather than in someone's drawer.
  const moves: Record<string, Partial<Session>> = {
    providerId: { providerId: "claude-code" },
    agentSessionId: { agentSessionId: "agent-2" },
    title: { title: "Renamed" },
    startedAt: { startedAt: NOW + 1 },
    cwd: { cwd: "/repo/other" },
    folder: { folder: "other" },
    messageCount: { messageCount: 7 },
    unread: { unread: true },
  };

  const base = sessionCacheKey([session()]);
  for (const [field, change] of Object.entries(moves)) {
    expect(`${field}: ${sessionCacheKey([session(change)])}`).not.toBe(`${field}: ${base}`);
  }

  // `id` is not listed because it is not independent: it is derived from
  // providerId + agentSessionId, both of which are covered above.
  const stored = toCachedSessions([session({ folder: "pew2", messageCount: 3, unread: true })])[0]!;
  expect(Object.keys(stored).sort()).toEqual(["id", ...Object.keys(moves)].sort());
});
