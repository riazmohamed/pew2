import { expect, test } from "bun:test";
import {
  CLEAR,
  KEYS,
  draftSteps,
  NativeTyper,
  appleText,
  nativeAlive,
  nativeCommand,
  nativeOpenScript,
  nativeProviders,
  nativeWriteScript,
  typeable,
  type OsaResult,
  applyDeskScreen,
  parseOgCoderScreen,
} from "./native-desk.js";

const ok = (stdout = "ok"): OsaResult => ({ code: 0, stdout, stderr: "", timedOut: false });

test("native is announced only on macOS with iTerm, for installed agents that have an app", () => {
  const providers = [
    { id: "ggcoder", commandMissing: false },
    { id: "claude-code", commandMissing: false },
  ];
  expect(nativeProviders(providers, { platform: "darwin", hasITerm: true })).toEqual(["ggcoder"]);
  expect(nativeProviders(providers, { platform: "darwin", hasITerm: false })).toEqual([]);
  expect(nativeProviders(providers, { platform: "linux", hasITerm: true })).toEqual([]);
  expect(nativeProviders([{ id: "ggcoder", commandMissing: true }], { platform: "darwin", hasITerm: true })).toEqual([]);
});

test("the window runs the agent resumed in the project, quoted", () => {
  expect(nativeCommand("ogcoder", "ggcoder", "abc-123", "/p/my app")).toBe("cd '/p/my app' && exec ogcoder --resume abc-123");
  const script = nativeOpenScript(nativeCommand("ogcoder", "ggcoder", "abc", "/p/it's"), "OG Coder · it's");
  // Shell-quoted inside zsh -lc, then AppleScript-escaped.
  expect(script).toContain(`create window with default profile command "/bin/zsh -lc 'cd '\\\\''/p/it'\\\\''\\\\'\\\\'''\\\\''s'\\\\'' && exec ogcoder --resume abc'"`);
  expect(script).toContain("return id of newSession");
});

test("control keys become character ids; quotes are escaped", () => {
  expect(appleText(`a"b${KEYS.killLine}c`)).toBe(`"a\\"b" & (character id 21) & "c"`);
  expect(appleText("")).toBe('""');
  const script = nativeWriteScript("S1", [...CLEAR, "hi", KEYS.enter]);
  expect(script).toContain('if (id of aSession) is "S1" then');
  expect(script).toContain('write text "hi" newline NO');
  expect(script).toContain("delay 0.15");
  // Every control key is its own write.
  expect(script).toContain("write text (character id 5) newline NO");
  expect(script).toContain("write text (character id 21) newline NO");
  expect(script).toContain("write text (character id 13) newline NO");
});

test("phone text is made one line, so typing it never presses Enter", () => {
  expect(typeable("one\ntwo\r\nthree\u0007")).toBe("one two three");
});

test("drafts clear then type the latest text, throttled; prompt presses Enter; cancel is Esc", async () => {
  const scripts: string[] = [];
  const typer = new NativeTyper("S1", async (script) => (scripts.push(script), ok()), 20);
  typer.draft("h");
  typer.draft("he");
  typer.draft("hello");
  await Bun.sleep(60);
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).toContain("write text (character id 21) newline NO");
  // Typed key by key, the latest text only (throttled).
  for (const ch of "hello") expect(scripts[0]).toContain(`write text "${ch}" newline NO`);
  expect(scripts[0]).not.toContain('"hello" newline NO');
  expect(scripts[0]).not.toContain("character id 13");

  // A prompt drops a draft still waiting, and sends.
  typer.draft("stale");
  expect(await typer.prompt("send this")).toBe(true);
  await Bun.sleep(40);
  expect(scripts).toHaveLength(2);
  expect(scripts[1]).toContain('"send this" newline NO');
  expect(scripts[1]).toContain("(character id 13) newline NO");

  await typer.cancel();
  expect(scripts[2]).toContain("write text (character id 27) newline NO");
});

test("a gone window fails the prompt", async () => {
  const typer = new NativeTyper("S1", async () => ok("gone"));
  expect(await typer.prompt("x")).toBe(false);
});

test("alive: window gone, agent exited (shell only), agent running, unknown", async () => {
  const deps = (stdout: string, commands?: string[]) => ({
    osa: async () => ok(stdout),
    ttyCommands: async () => commands,
    hasITerm: () => true,
  });
  expect(await nativeAlive(deps("gone"), "S")).toBe(false);
  expect(await nativeAlive(deps("/dev/ttys004", ["-zsh"]), "S")).toBe(false);
  expect(await nativeAlive(deps("/dev/ttys004", ["/bin/zsh", "node"]), "S")).toBe(true);
  expect(await nativeAlive({ ...deps(""), osa: async () => ({ code: 1, stdout: "", stderr: "x", timedOut: false }) }, "S")).toBe(true);
});

test("drafts that only grow send just the new tail; any other edit clears and retypes", () => {
  expect(draftSteps(undefined, "h")).toEqual([...CLEAR, "h"]);
  // Key by key: OG Coder reads a multi-character write as a paste.
  expect(draftSteps("hello", "hello there")).toEqual([..." there"]);
  expect(draftSteps("hello", "hello")).toEqual([]);
  // An edit is backspaces to the common prefix, then the new tail.
  expect(draftSteps("hello from the phone", "hello from the Mac")).toEqual([
    ...Array<string>(5).fill(KEYS.backspace),
    ..."Mac",
  ]);
  expect(draftSteps("hello", "hell")).toEqual([KEYS.backspace]);
  expect(draftSteps("hello", "")).toEqual([...CLEAR]);
  // A long paste is one write after a clear.
  const long = "x".repeat(60);
  expect(draftSteps("", long)).toEqual([...CLEAR, long]);
});

test("the typer remembers what it typed", async () => {
  const scripts: string[] = [];
  const typer = new NativeTyper("S1", async (script) => (scripts.push(script), ok()), 5);
  typer.draft("hel");
  await Bun.sleep(20);
  typer.draft("hello");
  await Bun.sleep(20);
  expect(scripts[1]).toContain('write text "l" newline NO');
  expect(scripts[1]).toContain('write text "o" newline NO');
  expect(scripts[1]).not.toContain("character id 21");
  expect(scripts[1]).not.toContain("character id 21");
});

test("OG Coder's own commands run in its input, then the draft comes back", async () => {
  const scripts: string[] = [];
  const typer = new NativeTyper("S1", async (script) => (scripts.push(script), ok()), 5);
  typer.draft("half");
  await Bun.sleep(20);
  expect(await typer.command("/model claude-sonnet-5-5")).toBe(true);
  expect(scripts[1]).toContain('"/model claude-sonnet-5-5" newline NO');
  expect(scripts[1]).toContain("character id 13");
  expect(scripts[1]!.indexOf("character id 13")).toBeLessThan(scripts[1]!.lastIndexOf('"h" newline NO'));
  expect(await typer.shiftTab(2)).toBe(true);
  expect(scripts[2]!.match(/\[Z/g)).toHaveLength(2);
});

test("OG Coder's screen is read: input, placeholder, paste block, status line", () => {
  // Copied from a real OG Coder window (trailing padding included).
  const real = [
    " ○ ↻ Restored session (26 messages) ",
    "─".repeat(80),
    " ⠿ Ready to go.. ",
    "▄".repeat(80),
    " > hello from the Mac                                                           ",
    "▀".repeat(80),
    " Paddle_ken │ ⎇ sprint-2 │ 76 changed ",
    " ▏░░░░░░░ 1% │ Sonnet │ Plan off │ Thinking high ",
  ].join("\n");
  expect(parseOgCoderScreen(real)).toEqual({ input: "hello from the Mac", model: "Sonnet", plan: false, thinking: "high" });
  const empty = real.replace("hello from the Mac", "  Type your message or / to run a command");
  expect(parseOgCoderScreen(empty).input).toBe("");
  const pasted = real.replace("hello from the Mac", "[Pasted text #7 +1 lines]");
  expect(parseOgCoderScreen(pasted).input).toBeUndefined();
  const wrapped = real.replace(" > hello from the Mac", " > a long line that wraps\n   onto the next line");
  expect(parseOgCoderScreen(wrapped).input).toBe("a long line that wraps onto the next line");
  expect(parseOgCoderScreen(real.replace("Plan off │ Thinking high", "Plan on │ Thinking off"))).toMatchObject({ plan: true, thinking: "off" });
  expect(parseOgCoderScreen("no window here")).toEqual({});
});

test("the status line moves the pills, matched by OG Coder's short names", () => {
  const options = [
    { id: "model", category: "model", currentValue: "claude-opus-5-5", options: [{ value: "claude-opus-5-5", name: "Claude Opus 5.5" }, { value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }, { value: "gpt-6-astra", name: "GPT-6 Astra" }] },
    { id: "thinking", category: "thought_level", currentValue: "high", options: ["off", "low", "high", "max"].map((value) => ({ value })) },
    { id: "mode", category: "mode", currentValue: "default", options: [{ value: "default" }, { value: "plan" }] },
  ];
  const moved = applyDeskScreen(options, { model: "Sonnet", thinking: "max", plan: true });
  expect(moved.changed).toBe(true);
  expect(moved.options.map((o) => o.currentValue)).toEqual(["claude-sonnet-5-5", "max", "plan"]);
  expect(applyDeskScreen(options, { model: "GPT-6 Astra" }).options[0]!.currentValue).toBe("gpt-6-astra");
  expect(applyDeskScreen(options, { model: "Opus", thinking: "high", plan: false }).changed).toBe(false);
  // An unknown label leaves the pill alone rather than guessing.
  expect(applyDeskScreen(options, { model: "Mystery" }).changed).toBe(false);
});
