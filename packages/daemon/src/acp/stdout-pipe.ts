/**
 * Giving a child a stdout descriptor its runtime can actually write to.
 *
 * The daemon runs under Bun, and Bun's `child_process.spawn` hands a child a
 * stdout handle that Python's asyncio cannot drive. The failure is silent and
 * badly signposted: the agent receives `initialize`, logs that it received it,
 * writes its reply — and nothing arrives. Sixty seconds later the session dies
 * reporting that the process "started but never completed the ACP handshake",
 * which reads like a protocol or flag problem and sends you looking in the
 * wrong place entirely.
 *
 * Measured, not assumed. The same agent spawned from Node replies immediately;
 * spawned from Bun it is silent; spawned from Bun through `sh -c '… | cat'` it
 * replies. So the fix is to put a real shell pipe between the two, which costs
 * one `cat` process per session.
 *
 * Opt-in per manifest rather than applied to everything: every agent shipping
 * today works on the direct path, and a wrapper that is always on would add a
 * process, an extra layer to debug, and a POSIX dependency to agents that have
 * no need of any of it.
 */

/** A resolved argv, before or after wrapping. */
export interface Argv {
  command: string;
  args: string[];
}

/**
 * Wrap an argv so the child's stdout is a shell pipe.
 *
 * `"$0" "$@"` is used rather than interpolating the command into the script,
 * because a path containing a space or a quote would otherwise be re-split by
 * the shell — turning a working agent into a confusing "not found".
 *
 * Windows has no `/bin/sh`, and the Bun/asyncio interaction this works around
 * is not known to occur there, so the wrap is skipped rather than guessed at.
 */
export function withStdoutPipe(argv: Argv, enabled: boolean): Argv {
  if (!enabled || process.platform === "win32") return argv;
  return {
    command: "/bin/sh",
    args: ["-c", '"$0" "$@" | cat', argv.command, ...argv.args],
  };
}
