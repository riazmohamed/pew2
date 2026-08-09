import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { encodeCwd, listStoredSessions } from "./ogcoder-sessions.js";

/**
 * The lister, told that every project path in these tests is on disk.
 *
 * Real directories cannot be used: they would have to live under the OS temp
 * root, which the scratch filter deliberately rejects.
 */
const list = (cwd: string | undefined, root: string) =>
  listStoredSessions(cwd, root, { exists: () => true });

const CWD = "/Users/x/code/app";

async function root(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "ogcoder-sessions-"));
  await mkdir(join(base, encodeCwd(CWD)), { recursive: true });
  return base;
}

/** One session file, in GG Coder's on-disk shape. */
function jsonl(id: string, firstUserText?: string, cwd = CWD): string {
  const lines = [
    JSON.stringify({
      type: "session",
      version: 2,
      id,
      cwd,
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
  ];
  if (firstUserText !== undefined) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: "m1",
        message: { role: "user", content: firstUserText },
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

async function write(
  base: string,
  name: string,
  body: string,
  mtime?: Date,
): Promise<void> {
  const path = join(base, encodeCwd(CWD), name);
  await writeFile(path, body);
  if (mtime) await utimes(path, mtime, mtime);
}

test("the cwd encoding matches GG Coder's directory names", () => {
  // Verified against a real store: /private/tmp -> private_tmp.
  expect(encodeCwd("/private/tmp")).toBe("private_tmp");
  expect(encodeCwd("/Users/riaz.mohamed/Desktop")).toBe("Users_riaz.mohamed_Desktop");
});

test("a directory the agent has never run in lists nothing, and does not throw", async () => {
  // Indistinguishable from an unreadable directory at this level, and both
  // should show an empty sidebar rather than an error.
  expect(await listStoredSessions("/nowhere", await root())).toEqual([]);
});

test("the first user message becomes the title", async () => {
  const base = await root();
  await write(base, "2026-01-01T00-00-00-000Z_aaaaaaaa.jsonl", jsonl("aaaaaaaa-1", "Fix the login bug"));

  const [session] = await list(CWD, base);
  expect(session?.title).toBe("Fix the login bug");
  expect(session?.sessionId).toBe("aaaaaaaa-1");
  expect(session?.cwd).toBe(CWD);
});

test("a session with no user message still gets a row", async () => {
  // A thread opened and abandoned is real; omitting it would make the sidebar
  // disagree with what is on disk.
  const base = await root();
  await write(base, "2026-01-01T00-00-00-000Z_bbbbbbbb.jsonl", jsonl("bbbbbbbb-1"));

  const [session] = await list(CWD, base);
  expect(session?.title).toBe("Untitled session");
});

test("array content and long titles are flattened and clipped", async () => {
  const base = await root();
  await write(
    base,
    "2026-01-01T00-00-00-000Z_cccccccc.jsonl",
    `${JSON.stringify({ type: "session", id: "cccccccc-1", cwd: CWD })}\n${JSON.stringify({
      type: "message",
      id: "m1",
      message: { role: "user", content: [{ type: "text", text: `line one\nline two ${"x".repeat(200)}` }] },
    })}\n`,
  );

  const [session] = await list(CWD, base);
  expect(session?.title.includes("\n")).toBe(false);
  expect(session?.title.length).toBe(60);
  expect(session?.title.endsWith("…")).toBe(true);
});

test("rows are newest first, by modification time", async () => {
  // Ordering by the header timestamp would bury a thread used all morning
  // under one created last week and never touched.
  const base = await root();
  await write(base, "a_11111111.jsonl", jsonl("11111111-1", "older"), new Date("2026-01-02T00:00:00Z"));
  await write(base, "b_22222222.jsonl", jsonl("22222222-1", "newer"), new Date("2026-06-01T00:00:00Z"));

  const sessions = await list(CWD, base);
  expect(sessions.map((entry) => entry.title)).toEqual(["newer", "older"]);
});

test("an archived session and its stub collapse to one row", async () => {
  // Archival leaves a `.jsonl` redirect beside the `.jsonl.gz`. Two rows for
  // one conversation looks like data loss when the stale copy is opened.
  const base = await root();
  const body = jsonl("dddddddd-1", "archived thread");
  await write(base, "c_dddddddd.jsonl", body, new Date("2026-01-01T00:00:00Z"));
  await writeFile(join(base, encodeCwd(CWD), "c_dddddddd.jsonl.gz"), gzipSync(Buffer.from(body)));

  const sessions = await list(CWD, base);
  expect(sessions.length).toBe(1);
  expect(sessions[0]?.title).toBe("archived thread");
});

test("a corrupt file is skipped without hiding the good ones beside it", async () => {
  const base = await root();
  await write(base, "d_eeeeeeee.jsonl", "{not json at all\n");
  await write(base, "e_ffffffff.jsonl", jsonl("ffffffff-1", "still here"));

  const sessions = await list(CWD, base);
  expect(sessions.map((entry) => entry.title)).toEqual(["still here"]);
});

test("with no cwd, every project's sessions are returned", async () => {
  // The daemon calls session/list with no arguments and folds the result into
  // the app's project picker. Scoping this to one directory left the picker
  // searching for folders that were never coming.
  const base = await mkdtemp(join(tmpdir(), "ogcoder-all-"));
  const other = "/Users/x/code/other";
  await mkdir(join(base, encodeCwd(CWD)), { recursive: true });
  await mkdir(join(base, encodeCwd(other)), { recursive: true });
  await writeFile(
    join(base, encodeCwd(CWD), "a_11111111.jsonl"),
    jsonl("11111111-1", "first project", CWD),
  );
  await writeFile(
    join(base, encodeCwd(other), "b_22222222.jsonl"),
    jsonl("22222222-1", "second project", other),
  );

  const all = await list(undefined, base);
  expect(new Set(all.map((entry) => entry.cwd))).toEqual(new Set([CWD, other]));

  // Narrowing still works, for the sidebar of one open project.
  const scoped = await list(CWD, base);
  expect(scoped.map((entry) => entry.cwd)).toEqual([CWD]);
});

test("a scratch directory is rejected even though it exists", async () => {
  // `providers verify` spawns a real session in a temp directory and leaves it
  // behind on purpose, so without this every verification run adds a row to the
  // user's project picker.
  const base = await mkdtemp(join(tmpdir(), "ogcoder-scratch-"));
  const scratch = join(tmpdir(), "pew2-verify-abc123");
  await mkdir(join(base, encodeCwd(scratch)), { recursive: true });
  await writeFile(
    join(base, encodeCwd(scratch), "a_33333333.jsonl"),
    jsonl("33333333-1", "a verification run", scratch),
  );

  // `exists: () => true` on purpose: this proves the scratch filter is doing
  // the work, rather than the existence check happening to agree.
  expect(await list(undefined, base)).toEqual([]);
});

test("a project whose directory is gone is not offered", async () => {
  const base = await mkdtemp(join(tmpdir(), "ogcoder-gone-"));
  const deleted = "/Users/x/code/deleted-project";
  await mkdir(join(base, encodeCwd(deleted)), { recursive: true });
  await writeFile(
    join(base, encodeCwd(deleted), "a_44444444.jsonl"),
    jsonl("44444444-1", "old work", deleted),
  );

  // The real `existsSync`, since that is the behaviour under test.
  expect(await listStoredSessions(undefined, base)).toEqual([]);
});
