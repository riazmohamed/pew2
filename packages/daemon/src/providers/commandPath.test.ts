/**
 * `commandPath` hands an iTerm window the agent's full path. The window's
 * login shell can lack the agent's folder (pnpm's lives only in `~/.zshrc`),
 * and a bare name there exits at once: "Can't get current session of missing
 * value" on the phone's Open in OG Coder.
 */
import { test, expect } from "bun:test";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandPath } from "./registry.js";

async function executable(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, 0o755);
  return path;
}

test("a name on the daemon's PATH resolves to its full path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pew2-resolve-"));
  const path = await executable(join(root, "Library", "pnpm"), "ogcoder");
  expect(commandPath("ogcoder", { PATH: `/nowhere:${join(root, "Library", "pnpm")}`, HOME: root })).toBe(path);
});

test("a missing command resolves to undefined, so the bare name is kept", async () => {
  const root = await mkdtemp(join(tmpdir(), "pew2-resolve-"));
  expect(commandPath("pew2-no-such-agent", { PATH: root, HOME: root })).toBeUndefined();
});

test("a non-executable file of the right name is not the command", async () => {
  const root = await mkdtemp(join(tmpdir(), "pew2-resolve-"));
  await writeFile(join(root, "ogcoder"), "");
  expect(commandPath("ogcoder", { PATH: root, HOME: root })).toBeUndefined();
});
