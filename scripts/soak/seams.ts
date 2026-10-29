/**
 * Test seams loaded *inside* the isolated soak daemon (`PEW2_TEST_SEAMS`).
 *
 * The daemon opens OG Coder and `pew2 chat` windows with AppleScript against
 * iTerm. A stress run must never touch the real screen (or start a real
 * `ogcoder`, which would spend credits), so this stands in a fake iTerm: every
 * script the daemon runs is parsed, windows are tracked in memory, and the
 * state is written to `$PEW2_SOAK_DIR/fake-iterm.json` after every change so the
 * harness (a different process) can check for leaked windows and for a second
 * writer on one conversation.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

interface FakeWindow {
  id: string;
  tty: string;
  /** The command the window was opened with (`ogcoder --resume …` or `pew2 chat …`). */
  command: string;
  open: boolean;
  openedAt: number;
  closedAt?: number;
  /** Keystrokes written to it, newest last (bounded). */
  writes: string[];
}

const soakDir = process.env.PEW2_SOAK_DIR;
const windows = new Map<string, FakeWindow>();
let next = 1;

function persist(): void {
  if (!soakDir) return;
  try {
    writeFileSync(
      path.join(soakDir, "fake-iterm.json"),
      JSON.stringify({ at: Date.now(), windows: [...windows.values()] }, null, 2),
    );
  } catch {
    // The harness reads it best-effort; a missed write shows on the next one.
  }
}

/** The string inside `create window with default profile command "…"`, unquoted. */
function commandOf(script: string): string {
  const match = /create window with default profile command (".*")\)?\s*$/m.exec(script);
  if (!match) return "";
  try {
    return JSON.parse(match[1]!.replace(/\)$/, "")) as string;
  } catch {
    return match[1]!;
  }
}

function sessionIdOf(script: string): string | undefined {
  return /if \(id of aSession\) is "([^"]+)" then/.exec(script)?.[1];
}

function open(script: string): string {
  const id = `fake-iterm-${process.pid}-${next++}`;
  windows.set(id, {
    id,
    tty: `/dev/ttysoak${next}`,
    command: commandOf(script),
    open: true,
    openedAt: Date.now(),
    writes: [],
  });
  persist();
  return id;
}

function close(window: FakeWindow): void {
  if (!window.open) return;
  window.open = false;
  window.closedAt = Date.now();
  persist();
}

/** One AppleScript, answered as iTerm would. */
async function osa(
  script: string,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false });
  if (script.includes("create window with default profile command")) return ok(open(script));
  const id = sessionIdOf(script);
  if (!id) return ok("");
  const window = windows.get(id);
  if (!window || !window.open) return ok("gone");
  if (script.includes("return tty of aSession")) return ok(window.tty);
  if (script.includes("close aSession")) {
    close(window);
    return ok("ok");
  }
  if (script.includes("contents of aSession")) return ok("");
  if (script.includes("write text")) {
    const texts = [...script.matchAll(/write text (.+?) newline NO/g)].map((m) => m[1]!);
    window.writes.push(...texts);
    window.writes.splice(0, Math.max(0, window.writes.length - 40));
    // Ctrl-C quits both `pew2 chat` and OG Coder's TUI: the window drops back
    // to its shell, which the daemon reads as the agent having gone.
    if (texts.some((text) => /\(character id 3\)/.test(text))) close(window);
    persist();
    return ok("ok");
  }
  return ok("ok");
}

/** The `NativeOptions` the soak daemon is built with. */
export function nativeOptions() {
  persist();
  return {
    platform: "darwin" as const,
    hasITerm: () => true,
    osa,
    // A window still open runs its agent; a closed one only has its shell.
    ttyCommands: async (tty: string) => {
      const window = [...windows.values()].find((w) => w.tty === tty);
      return window?.open ? ["ogcoder"] : ["-zsh"];
    },
    // Fast enough that a 2-minute run gets through many cycles, slow enough
    // to still exercise the debounces and settle windows the daemon relies on.
    pollMs: 60,
    alivePollMs: 250,
    closeWaitMs: 3_000,
    closePollMs: 60,
    readPollMs: 300,
    throttleMs: 20,
    desk: {
      runAppleScript: async (script: string) => {
        const result = await osa(script);
        return { code: result.code, stdout: result.stdout, stderr: "", timedOut: false };
      },
      openCommandFile: async () => {
        throw new Error("soak: Terminal fallback is not allowed (iTerm is faked)");
      },
      hasITerm: () => true,
    },
  };
}
