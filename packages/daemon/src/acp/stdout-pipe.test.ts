import { expect, test } from "bun:test";
import { withStdoutPipe } from "./stdout-pipe.js";

const argv = { command: "hermes", args: ["acp"] };

test("an agent that did not ask for the wrapper is spawned directly", () => {
  // The common path must stay a plain spawn: no extra process, nothing to debug.
  expect(withStdoutPipe(argv, false)).toEqual(argv);
});

test("the wrapper puts a shell pipe between the agent and the daemon", () => {
  expect(withStdoutPipe(argv, true)).toEqual({
    command: "/bin/sh",
    args: ["-c", '"$0" "$@" | cat', "hermes", "acp"],
  });
});

test("the command is passed as an argument, never interpolated into the script", () => {
  // A path with a space, re-split by the shell, becomes a baffling "not found".
  const spaced = { command: "/Apps/My Agent/hermes", args: ["acp", "--flag=a b"] };
  const wrapped = withStdoutPipe(spaced, true);

  expect(wrapped.args[1]).toBe('"$0" "$@" | cat');
  expect(wrapped.args.slice(2)).toEqual(["/Apps/My Agent/hermes", "acp", "--flag=a b"]);
});

test("an agent with no arguments still wraps correctly", () => {
  expect(withStdoutPipe({ command: "agent", args: [] }, true).args).toEqual([
    "-c",
    '"$0" "$@" | cat',
    "agent",
  ]);
});
