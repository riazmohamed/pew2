import { expect, test } from "bun:test";
import {
  isCompiled,
  resolveSelfCommand,
  selfCommand,
  SELF_PLACEHOLDER,
} from "./self-command.js";

const ENTRY = "/repo/packages/daemon/src/cli/index.ts";
const fromSource = { moduleUrl: "file:///repo/packages/daemon/src/providers/self-command.ts" };
const compiled = { moduleUrl: "file:///$bunfs/root/self-command.ts" };

test("Bun's embedded filesystem is recognised as a compiled build", () => {
  // The whole substitution turns on this: get it wrong and a compiled binary
  // tries to `bun run` a `.ts` file that does not exist on disk.
  expect(isCompiled("file:///$bunfs/root/cli.ts")).toBe(true);
  expect(isCompiled("B:/~BUN/root/cli.ts")).toBe(true);
  expect(isCompiled("file:///repo/packages/daemon/src/providers/self-command.ts")).toBe(false);
});

test("a compiled binary invokes itself with no prefix arguments", () => {
  expect(selfCommand({ ...compiled, execPath: "/usr/local/bin/pew2" })).toEqual({
    command: "/usr/local/bin/pew2",
    prefixArgs: [],
  });
});

test("a checkout invokes bun against the CLI entrypoint", () => {
  // `process.execPath` is the Bun runtime here, so spawning it bare would open
  // a REPL and hang the handshake rather than fail.
  expect(
    selfCommand({ ...fromSource, execPath: "/home/u/.bun/bin/bun", entrypoint: () => ENTRY }),
  ).toEqual({ command: "/home/u/.bun/bin/bun", prefixArgs: ["run", ENTRY] });
});

test("the placeholder expands ahead of the manifest's own arguments", () => {
  // Order matters: `bun run <entry> __bridge ogcoder`. Any other arrangement
  // makes Bun treat the subcommand as the script to run.
  expect(
    resolveSelfCommand(SELF_PLACEHOLDER, ["__bridge", "ogcoder"], {
      ...fromSource,
      execPath: "/home/u/.bun/bin/bun",
      entrypoint: () => ENTRY,
    }),
  ).toEqual({
    command: "/home/u/.bun/bin/bun",
    args: ["run", ENTRY, "__bridge", "ogcoder"],
  });
});

test("a manifest naming a real binary is left exactly as written", () => {
  // This runs on every spawn, so the common path must not touch anything.
  expect(resolveSelfCommand("claude-code-acp", ["--stdio"], fromSource)).toEqual({
    command: "claude-code-acp",
    args: ["--stdio"],
  });
});

test("the returned arguments are a copy, not the manifest's own array", () => {
  // The manifest object is shared across spawns; mutating its args once would
  // corrupt every later session on that provider.
  const args = ["--stdio"];
  const resolved = resolveSelfCommand("some-agent", args, fromSource);
  resolved.args.push("--extra");
  expect(args).toEqual(["--stdio"]);
});
