# OG Coder + Hermes: what works, and what is still owed

**Written 2026-08-09.** Read this before touching either provider.

Both agents ship inside pew2 now. A fresh clone gets them; nothing under
`~/.pew2` is required.

---

## Will it keep working?

**Yes.** Reboots, daemon restarts, phone reconnects, roaming, and moving this
repo are all fine. The machine-local files this used to depend on are gone.

Two conditions remain, and neither is specific to these agents:

| # | Condition | What breaks it | Symptom on the phone |
|---|-----------|----------------|----------------------|
| 1 | `bun` keeps Full Disk Access | Revoking it; **replacing the bun binary may silently drop the grant** | Every agent hangs, daemon logs stay empty |
| 2 | The agent stays installed | Uninstalling `ogcoder` / `hermes` | The agent drops off the list, honestly |

**One thing is still machine-local:** the `--resume` fix lives in `gg-framework`
at commit `a28cca93` and is only in your local `dist/`. Until it is published, a
clone of pew2 talking to a stock `ogcoder` gets session history with no agent
memory behind it.

---

## What shipped

**pew2 `f4bf52e`** — the bridge and its modules:

- `acp/ogcoder-bridge.ts` — ACP on stdio, one `ogcoder --rpc` child per session
- `acp/ogcoder-binary.ts` — finds `ogcoder` before `ggcoder`, searches
  pnpm/bun/homebrew dirs as well as PATH
- `acp/ogcoder-tools.ts` — tool name to ACP kind and title
- `acp/ogcoder-models.ts` — reads GG Coder's own `MODELS` registry, filtered to
  logged-in providers
- `acp/ogcoder-sessions.ts` — lists conversations from the JSONL store

**pew2 `f7e454a`** — made it shippable:

- `${PEW2_SELF}` in a manifest plus a hidden `pew2 __bridge <id>` subcommand, so
  the bridge travels inside the compiled binary
- `requiresCommand` — availability from the real dependency, not from pew2
- `stdoutPipe` — the Bun/asyncio stdout fix, replacing the `~/.pew2` shim
- `session/list` with no cwd now walks the whole store, which is what fills the
  app's project picker
- `doctor` ignores agents the user switched off

**gg-framework `a28cca93`** — `--rpc --resume` was parsed and dropped;
`resolveResumePath` now plumbs it through. Committed, **not published**.

## Agents currently switched off

`cline`, `gemini-cli`, `opencode`, `qwen-code` — in `~/.pew2/disabled.json`.
Bring one back with `pew2 providers enable <id>`.

---

## The bridge's replacement, and why it is not in use yet

GG Coder 5.37.0 added a native `acp` subcommand (`modes/acp-mode.ts`). It is
strictly better than the bridge: `session/close` and `session/delete` on top of
what the bridge does, plus real diffs.

It is **not** wired up because every published build of it ignores the `cwd` a
client sends with `session/new` and uses the agent process's own directory
instead. Under a daemon that is `/`:

- **Loud failure:** `session/new` returns `ENOENT: ... mkdir '/.gg'`.
- **Silent, and worse:** where the process directory is writable, the session
  is created and runs against the wrong project — verified by spawning in one
  directory, asking for another, and watching the agent list the first.

Fixed locally in gg-framework `07a8090e`. **Once a build carrying that fix is
published**, switch `providers/ggcoder.json` to:

```json
"distribution": { "type": "command", "command": "ogcoder", "args": ["acp"] }
```

and delete `packages/daemon/src/acp/ogcoder-*.ts`. Keep the manifest id
`ggcoder`: the daemon keys history hydration off it
(`acp/messageCounts.ts`, `index.ts`).

## The work still owed

### 1. Publish the `--resume` fix

`a28cca93` is committed to `rebrand/abukhaled`, unpublished. Until it ships,
resume works only on this machine's `dist/`. The bug is in upstream `ggcoder`
too, so it is worth sending there as well.

### 2. Contribute the Hermes manifest upstream

Hermes had no bundled manifest before this work. It now ships with
`stdoutPipe: true`, which is worth upstreaming with the reasoning intact: any
Python ACP agent spawned from Bun hits the same wall.

### 3. Clean up the npm cache properly

218 root-owned files in `~/.npm/_cacache`, from an old `sudo npm`, break `npx`.
Worked around with `cache=~/.npm-pew2-cache` in `~/.npmrc`. Real fix:
`sudo chown -R "$(whoami)" ~/.npm`

---

## Traps worth remembering

- **`AgentSession`'s `sessionId` option takes a session *path*, not an id.**
  Passing an id loads nothing and silently starts an empty conversation. This is
  the whole bug behind `--resume`.
- **Bun's `spawn` gives a child a stdout descriptor Python's asyncio cannot
  write to.** The reply never arrives and the session dies on a 60s timeout that
  blames the handshake. `stdoutPipe: true` is the fix; it will be needed by any
  Python agent, not just Hermes.
- **`abort` in `--rpc` is fatal.** It trips the AbortController the session was
  built with, so the child cannot serve another turn. Cancel therefore kills the
  child; the next prompt respawns it with `--resume`.
- **A child is a session.** `--rpc` takes cwd from `process.cwd()` and opens its
  conversation on spawn, so ACP's per-session `cwd` requires one child each.
- **The daemon calls `session/list` with no arguments** and folds the result into
  the app's project picker. An agent that scopes that call to one directory
  leaves the picker empty forever.
- **Thinking level is deliberately not exposed.** `--rpc` accepts it only at
  construction, so a dropdown would have to discard the conversation to apply.
- **`pew2 service install` bakes the installing shell's PATH into the plist.** It
  is a snapshot: an agent installed afterwards is invisible to the running
  daemon, which looks like a provider that works in the terminal and is missing
  on the phone. `canResolveCommand` also searches the usual package-manager bin
  directories because of this.
- **The daemon starts at login, not boot.** With FileVault on, a reboot parks at
  the login screen and the daemon never starts.

---

## Verifying after any change

```bash
pew2 providers verify ggcoder      # expect: ok
pew2 providers verify hermes       # expect: ok
pew2 doctor                        # expect: everything checks out
```

The case that actually broke before is the compiled binary, so test that too:

```bash
bun build --compile packages/daemon/src/cli/index.ts --outfile /tmp/pew2-test
/tmp/pew2-test providers verify ggcoder
```

A real end-to-end check is the phone: pull to refresh, open OG Coder, confirm
the folder picker lists your projects, the model pill lists ~20 models, the
sidebar lists past chats, and a resumed chat can recall something from earlier
in that thread.
