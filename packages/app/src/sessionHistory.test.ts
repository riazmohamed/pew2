import { expect, test } from "bun:test";
import type { Session } from "./useDaemon";
import { recentSessionsForProvider, SESSION_HISTORY_LIMIT } from "./sessionHistory";

function session(index: number, providerId = "ggcoder"): Session {
  return {
    id: `session-${index}`,
    providerId,
    title: `Session ${index}`,
    startedAt: 100 - index,
    turns: [],
    configOptions: [],
  };
}

test("the drawer shows only the 30 most recent sessions for an app", () => {
  const sessions = [
    ...Array.from({ length: 36 }, (_, index) => session(index)),
    session(99, "claude-code"),
  ];

  const visible = recentSessionsForProvider(sessions, "ggcoder");

  expect(visible).toHaveLength(SESSION_HISTORY_LIMIT);
  expect(visible[0]?.id).toBe("session-0");
  expect(visible.at(-1)?.id).toBe("session-29");
});

test("a quiet project keeps its newest conversation however busy the rest are", () => {
  const sessions = [
    ...Array.from({ length: 40 }, (_, index) => ({
      ...session(index),
      cwd: "/a/busy",
      startedAt: 1000 - index,
    })),
    { ...session(500), cwd: "/a/quiet", startedAt: 5 },
    { ...session(501), cwd: "/a/quiet", startedAt: 4 },
  ];

  const visible = recentSessionsForProvider(sessions, "ggcoder");

  expect(visible).toHaveLength(SESSION_HISTORY_LIMIT);
  // Exactly one row for the quiet repo: its newest, not both.
  expect(visible.filter((s) => s.cwd === "/a/quiet").map((s) => s.id)).toEqual(["session-500"]);
  expect(visible[0]?.id).toBe("session-0");
});

test("a conversation this app started groups by folder until it has a path", () => {
  const sessions = [
    ...Array.from({ length: 40 }, (_, index) => ({
      ...session(index),
      cwd: "/a/busy",
      startedAt: 1000 - index,
    })),
    { ...session(600), folder: "pew2", startedAt: 6 },
    { ...session(601), folder: "pew2", startedAt: 5 },
  ];

  const visible = recentSessionsForProvider(sessions, "ggcoder");

  expect(visible.filter((s) => s.folder === "pew2").map((s) => s.id)).toEqual(["session-600"]);
});

test("choosing a project is still a plain newest-first cap of its own rows", () => {
  const sessions = Array.from({ length: 36 }, (_, index) => ({
    ...session(index),
    cwd: "/a/one",
  }));

  const visible = recentSessionsForProvider(sessions, "ggcoder");

  expect(visible).toHaveLength(SESSION_HISTORY_LIMIT);
  expect(visible.every((s) => s.cwd === "/a/one")).toBe(true);
  expect(visible[0]?.id).toBe("session-0");
  expect(visible.at(-1)?.id).toBe("session-29");
});
