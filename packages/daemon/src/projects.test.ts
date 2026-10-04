import { expect, test } from "bun:test";
import { foldProjects, sessionsInProject, stratifiedSessions } from "./projects.js";

test("a project is counted once however many conversations it holds", () => {
  const projects = foldProjects([
    { cwd: "/Users/x/code/pew2", updatedAt: "2026-08-01T10:00:00Z" },
    { cwd: "/Users/x/code/pew2", updatedAt: "2026-07-30T10:00:00Z" },
    { cwd: "/Users/x/code/site", updatedAt: "2026-07-31T10:00:00Z" },
  ]);

  expect(projects.map((p) => [p.name, p.sessions])).toEqual([
    ["pew2", 2],
    ["site", 1],
  ]);
});

test("projects order by their newest conversation, not by the first row seen", () => {
  const projects = foldProjects([
    { cwd: "/a/old", updatedAt: "2026-01-01T00:00:00Z" },
    { cwd: "/a/new", updatedAt: "2026-08-01T00:00:00Z" },
  ]);

  expect(projects[0]!.name).toBe("new");
});

test("a project's stamp is the newest of its sessions even when a later row is the dated one", () => {
  const [project] = foldProjects([
    { cwd: "/a/repo" },
    { cwd: "/a/repo", updatedAt: "2026-08-01T00:00:00Z" },
  ]);

  expect(project!.updatedAt).toBe("2026-08-01T00:00:00Z");
});

test("sessions with no project are skipped rather than listed as a nameless row", () => {
  expect(foldProjects([{ cwd: "" }, { cwd: "   " }])).toEqual([]);
});

test("choosing a project lists only its own conversations, capped", () => {
  const sessions = [
    { sessionId: "1", cwd: "/a/one" },
    { sessionId: "2", cwd: "/a/two" },
    { sessionId: "3", cwd: "/a/one" },
  ];

  expect(sessionsInProject(sessions, "/a/one", 30).map((s) => s.sessionId)).toEqual(["1", "3"]);
  expect(sessionsInProject(sessions, "/a/one", 1).map((s) => s.sessionId)).toEqual(["1"]);
});

test("the capped list keeps a quiet project's newest conversation", () => {
  // Thirty-one newer conversations in one busy repo, one old one in another:
  // a flat newest-30 slice would show nothing but the busy repo.
  const base = Date.parse("2026-09-30T00:00:00Z");
  const sessions = [
    ...Array.from({ length: 31 }, (_, index) => ({
      sessionId: `busy-${index}`,
      cwd: "/a/busy",
      updatedAt: new Date(base + index * 60_000).toISOString(),
    })),
    { sessionId: "quiet", cwd: "/a/quiet", updatedAt: "2026-09-01T00:00:00Z" },
  ];

  const visible = stratifiedSessions(sessions, 30);

  expect(visible).toHaveLength(30);
  expect(visible.map((s) => s.sessionId)).toContain("quiet");
  // Still a timeline: the newest row overall is first.
  expect(visible[0]?.sessionId).toBe("busy-30");
});

test("stratification spends one row per project, then the newest overall", () => {
  const sessions = [
    { sessionId: "a1", cwd: "/a", updatedAt: "2026-09-05T00:00:00Z" },
    { sessionId: "b1", cwd: "/b", updatedAt: "2026-09-04T00:00:00Z" },
    { sessionId: "c1", cwd: "/c", updatedAt: "2026-09-03T00:00:00Z" },
    { sessionId: "a2", cwd: "/a", updatedAt: "2026-09-02T00:00:00Z" },
    { sessionId: "b2", cwd: "/b", updatedAt: "2026-09-01T00:00:00Z" },
  ];

  const visible = stratifiedSessions(sessions, 4);

  // One row each for a, b, c, then the newest remainder (a2).
  expect(visible.map((s) => s.sessionId)).toEqual(["a1", "b1", "c1", "a2"]);
});

test("sessions with no project share one group rather than one row each", () => {
  const sessions = [
    { sessionId: "n1", cwd: "", updatedAt: "2026-09-05T00:00:00Z" },
    { sessionId: "n2", cwd: "   ", updatedAt: "2026-09-04T00:00:00Z" },
    { sessionId: "p1", cwd: "/a", updatedAt: "2026-09-03T00:00:00Z" },
  ];

  const visible = stratifiedSessions(sessions, 2);

  expect(visible.map((s) => s.sessionId)).toEqual(["n1", "p1"]);
});

test("a limit of zero lists nothing", () => {
  expect(stratifiedSessions([{ sessionId: "1", cwd: "/a" }], 0)).toEqual([]);
});

test("stratification does not reorder or duplicate what it is given", () => {
  const sessions = [
    { sessionId: "a1", cwd: "/a", updatedAt: "2026-09-02T00:00:00Z" },
    { sessionId: "a2", cwd: "/a", updatedAt: "2026-09-01T00:00:00Z" },
  ];

  expect(stratifiedSessions(sessions, 30).map((s) => s.sessionId)).toEqual(["a1", "a2"]);
});
