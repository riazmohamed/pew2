import { expect, test } from "bun:test";
import {
  HERE_FLAG,
  openWindowScript,
  pickTerminal,
  shellQuote,
  windowCommand,
} from "./chat-window.js";

test("shellQuote leaves plain paths alone and quotes the rest", () => {
  expect(shellQuote("/Users/me/.bun/bin/bun")).toBe("/Users/me/.bun/bin/bun");
  expect(shellQuote("/Users/me/My Repo/x.ts")).toBe("'/Users/me/My Repo/x.ts'");
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
});

test("the window runs this same pew2 inline, never opening another window", () => {
  const command = windowCommand({
    execPath: "/b/bun",
    script: "/r/cli/index.ts",
    compiled: false,
    args: ["--agent", "ggcoder", HERE_FLAG],
    env: {},
  });
  expect(command).toBe("exec /b/bun /r/cli/index.ts chat --here --agent ggcoder");
});

test("a compiled binary is run on its own, and test env is forwarded", () => {
  const command = windowCommand({
    execPath: "/usr/local/bin/pew2",
    script: "/$bunfs/root/index.js",
    compiled: true,
    args: [],
    env: { PEW2_PORT: "8899", PEW2_HOME: "/tmp/a b", HOME: "/x" },
  });
  expect(command).toBe(
    "exec env PEW2_PORT=8899 PEW2_HOME='/tmp/a b' /usr/local/bin/pew2 chat --here",
  );
});

test("iTerm is used when that is where the command was run", () => {
  expect(pickTerminal({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm");
  expect(pickTerminal({ TERM_PROGRAM: "Apple_Terminal" })).toBe("terminal");
  expect(pickTerminal({})).toBe("terminal");
});

test("the AppleScript escapes the command for both apps", () => {
  const iterm = openWindowScript("iterm", `exec '/a b/bun' chat --here`);
  expect(iterm).toContain('create window with default profile command "/bin/zsh -lc ');
  expect(iterm).not.toContain('command "/bin/zsh -lc exec');
  const terminal = openWindowScript("terminal", `exec "x" chat`);
  expect(terminal).toContain('do script "exec \\"x\\" chat"');
});
