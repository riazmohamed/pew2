import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "./doctor.js";

/** A provider that is installed but missing a variable it declares required. */
async function providerNeedingAKey(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "doctor-providers-"));
  await writeFile(
    join(dir, "needs-key.json"),
    JSON.stringify({
      id: "needs-key",
      name: "Needs Key",
      version: "1.0.0",
      description: "Installed, but missing a required variable.",
      distribution: { type: "command", command: "sh", args: ["-c", "true"] },
      pew: { env: [{ name: "SOME_KEY", required: true }] },
    }),
  );
  return dir;
}

/**
 * A `PEW2_HOME` whose `disabled.json` names the given ids.
 *
 * `PEW2_HOME` rather than `HOME`: the path is built from `homedir()`, which
 * reads the real user profile and ignores an overridden `HOME` on some
 * platforms — so a test pointing at a fake home would silently read the
 * developer's own settings.
 *
 * Version 2 because only that is read as a record of what the user chose. A
 * version 1 file is deliberately retired rather than migrated — see
 * `providers/enabled.ts` — so writing one here would test the retirement, not
 * this command. The last test does that on purpose.
 */
async function pew2HomeDisabling(...ids: string[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "doctor-home-"));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "disabled.json"), JSON.stringify({ version: 2, disabled: ids }));
  return home;
}

test("a missing required variable is reported while the agent is enabled", async () => {
  const dir = await providerNeedingAKey();
  const home = await pew2HomeDisabling();

  const report = await doctor({
    searchDirs: [dir],
    env: { PEW2_HOME: home, PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv,
  });

  expect(report.problems.some((problem) => problem.id === "provider-missing-env")).toBe(true);
});

test("an agent the user switched off is not reported as a problem", async () => {
  // Turning an agent off to stop hearing about it, and still hearing about it,
  // reads as the setting having been ignored.
  const dir = await providerNeedingAKey();
  const home = await pew2HomeDisabling("needs-key");

  const report = await doctor({
    searchDirs: [dir],
    env: { PEW2_HOME: home, PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv,
  });

  expect(report.problems.some((problem) => problem.id === "provider-missing-env")).toBe(false);
});

test("a retired version 1 list does not silence the warning", async () => {
  // The other side of the retirement, asserted here because this command is
  // where the difference is visible. A version 1 entry is not known to be a
  // choice the user made — setup wrote them for failed checks too — so it must
  // not go on suppressing a real problem. Being told about an agent that is
  // genuinely misconfigured is the recoverable direction; silence is not.
  const dir = await providerNeedingAKey();
  const home = await mkdtemp(join(tmpdir(), "doctor-home-"));
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "disabled.json"),
    JSON.stringify({ version: 1, disabled: ["needs-key"] }),
  );

  const report = await doctor({
    searchDirs: [dir],
    env: { PEW2_HOME: home, PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv,
  });

  expect(report.problems.some((problem) => problem.id === "provider-missing-env")).toBe(true);
});
