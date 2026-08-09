/**
 * Finding the GG Coder binary, whatever this machine calls it.
 *
 * The bundled manifest runs `ggcoder`. The published package is
 * `@abukhaled/ogcoder` and installs as `ogcoder`, so on a machine with the fork
 * the bundled manifest names a binary that does not exist — pew2 lists the
 * agent as "available to install" while it is sitting on the user's PATH under
 * a different name.
 *
 * Two further wrinkles make a plain PATH lookup insufficient:
 *
 *   - **pnpm's bin directory.** `ogcoder` installs to `~/Library/pnpm`, which
 *     is on an interactive shell's PATH via the user's profile but not on the
 *     PATH a launchd agent inherits. The daemon runs under launchd.
 *   - **Names are not versions.** Either name may be the newer install, so the
 *     fork is preferred only because a machine that has both almost certainly
 *     uses the fork — and `PEW2_OGCODER_BIN` overrides the guess entirely.
 */
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** Candidate names, most specific first. */
const NAMES = ["ogcoder", "ggcoder"] as const;

/**
 * Directories checked in addition to PATH.
 *
 * These are where JS package managers put global bins. A launchd PATH is
 * `/usr/bin:/bin:/usr/sbin:/sbin` unless something sets it, so without this
 * list the daemon cannot find an agent the user installed normally.
 */
function wellKnownDirs(home: string): string[] {
  return [
    join(home, "Library", "pnpm"),
    join(home, ".local", "share", "pnpm"),
    join(home, ".bun", "bin"),
    join(home, ".local", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Injected so the search is testable without touching the real filesystem. */
  isExecutable?: (path: string) => boolean;
}

function executableOnDisk(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The GG Coder binary to spawn, or `undefined` if this machine has none.
 *
 * Returning `undefined` rather than throwing lets the caller say "GG Coder is
 * not installed" instead of surfacing a spawn error, which is the difference
 * between a useful setup report and a stack trace.
 */
export function resolveOgcoderBin(options: ResolveOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const isExecutable = options.isExecutable ?? executableOnDisk;

  // An explicit override is taken at its word — including a bare name, which
  // lets someone point at a wrapper on their own PATH.
  const override = env.PEW2_OGCODER_BIN?.trim();
  if (override) {
    if (!isAbsolute(override)) return override;
    return isExecutable(override) ? override : undefined;
  }

  const dirs = [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    ...wellKnownDirs(home),
  ];

  // Name first, then directory: a machine with both binaries should get the
  // fork from wherever it lives, rather than whichever name a directory
  // earlier in PATH happens to hold.
  for (const name of NAMES) {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}
