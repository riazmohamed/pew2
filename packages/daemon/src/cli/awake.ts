/**
 * `pew2 awake [on|off|status]`: the keep-awake switch, from the terminal.
 *
 * Writes the same `keep-awake.json` the phone's switch does. The daemon re-reads
 * it every 30 seconds, so no restart is needed.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { keepAwakePath, readKeepAwakeEnabled, writeKeepAwakeEnabled } from "../keep-awake.js";

const run = promisify(execFile);

/**
 * Caffeinate processes that look like pew2's (`caffeinate -i -w <daemon pid>`)
 * and are listed by `pmset -g assertions`. Best-effort: [] on any failure.
 */
export function pew2Assertions(ps: string, pmset: string): number[] {
  const commands = new Map<number, string>();
  const rows: { pid: number; ppid: number; command: string }[] = [];
  for (const line of ps.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const row = { pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! };
    rows.push(row);
    commands.set(row.pid, row.command);
  }
  return rows
    .filter((row) => /caffeinate -i -w \d+/.test(row.command))
    .filter((row) => /pew2|server\.ts/.test(commands.get(row.ppid) ?? ""))
    .filter((row) => pmset.includes(`pid ${row.pid}(caffeinate)`))
    .map((row) => row.pid);
}

async function heldOnDarwin(): Promise<number[] | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const [ps, pmset] = await Promise.all([
      run("/bin/ps", ["-axo", "pid=,ppid=,command="]),
      run("/usr/bin/pmset", ["-g", "assertions"]),
    ]);
    return pew2Assertions(ps.stdout, pmset.stdout);
  } catch {
    return undefined;
  }
}

export async function cmdAwake(command: string | undefined, flags: Set<string>): Promise<number> {
  const json = flags.has("--json");
  if (command === "on" || command === "off") {
    const enabled = command === "on";
    await writeKeepAwakeEnabled(enabled);
    const message = enabled
      ? "Keep-awake is on: this machine will not idle-sleep while an agent is working or a client was active in the last 10 minutes. Takes effect within ~30s."
      : "Keep-awake is off: this machine sleeps on its usual schedule. Takes effect within ~30s.";
    console.log(json ? JSON.stringify({ ok: true, enabled, message }) : message);
    return 0;
  }
  if (command === undefined || command === "status") {
    const enabled = await readKeepAwakeEnabled();
    const held = await heldOnDarwin();
    const status = { ok: true, enabled, path: keepAwakePath(), holding: held === undefined ? undefined : held.length > 0 };
    if (json) {
      console.log(JSON.stringify(status));
    } else {
      console.log(`Keep-awake: ${enabled ? "on" : "off"} (${status.path})`);
      if (held !== undefined) {
        console.log(
          held.length > 0
            ? `Holding now: yes — caffeinate pid ${held.join(", ")} (see pmset -g assertions)`
            : "Holding now: no — nothing is in use, or the daemon is not running",
        );
      }
      console.log("Locked screen is fine. Lid closed on battery always sleeps.");
    }
    return 0;
  }
  console.error("Usage: pew2 awake [on|off|status] [--json]");
  return 1;
}
