# OG Coder + Hermes: what works, and what is still owed

**Written 2026-08-09.** Read this before touching either provider.

Both agents work from the phone today. Neither is finished: they run from
machine-local files that are not in this repo, so a fresh clone does not get
them, and some ordinary actions on this machine will break them.

---

## Will it keep working?

**Yes — on this machine, indefinitely, provided four things stay true.**

Reboots, daemon restarts, phone reconnects and roaming are all fine. Nothing
here expires or needs re-running.

It breaks if any of these change:

| # | Condition | What breaks it | Symptom on the phone |
|---|-----------|----------------|----------------------|
| 1 | This repo stays at `~/Desktop/projects/unfazed/unstablemind/pew2` | Moving or renaming any parent directory | OG Coder vanishes from the agent list |
| 2 | `~/.pew2/providers/{ggcoder,hermes}.json` keep existing | `pew2 setup --force`, deleting `~/.pew2`, a reinstall that rewrites providers | Agent vanishes, or reverts to the broken bundled manifest |
| 3 | `~/.pew2/bin/hermes-acp` keeps existing | Deleting `~/.pew2/bin` | Hermes handshake times out at 60s |
| 4 | `bun` keeps Full Disk Access | Revoking it in System Settings; **replacing the bun binary may silently drop the grant** | Every agent hangs, daemon logs stay empty |

Condition 1 is the fragile one. The manifest at
`~/.pew2/providers/ggcoder.json` names this checkout by absolute path, because
the bridge is a `.ts` file that only exists here.

**Also machine-local, for the same reason:** the `--resume` fix lives in
`gg-framework` at commit `a28cca93` and is only in your local `dist/`. Until
that is published, a clone of pew2 talking to a stock `ogcoder` gets session
history with no agent memory behind it.

---

## What is actually committed

**pew2 `f4bf52e`** — the bridge and its four modules, 15 tests:

- `packages/daemon/src/acp/ogcoder-bridge.ts` — ACP on stdio, one
  `ogcoder --rpc` child per session
- `ogcoder-binary.ts` — finds `ogcoder` before `ggcoder`, searches
  pnpm/bun/homebrew dirs as well as PATH
- `ogcoder-tools.ts` — tool name → ACP kind and title
- `ogcoder-models.ts` — reads GG Coder's own `MODELS` registry, filtered to
  logged-in providers
- `ogcoder-sessions.ts` — lists conversations from the JSONL store

**gg-framework `a28cca93`** — `--rpc --resume` was parsed and dropped;
`resolveResumePath` now plumbs it through. Committed, **not published**.

## What is not committed, and cannot be

Machine-local, holding it all together:

- `~/.pew2/providers/ggcoder.json` — absolute paths to `bun` and this checkout
- `~/.pew2/providers/hermes.json` — points at the shim below
- `~/.pew2/bin/hermes-acp` — stdout shim
- `~/.npmrc` → `cache=~/.npm-pew2-cache` — works around 218 root-owned files in
  `~/.npm/_cacache` from an old `sudo npm`. Real fix:
  `sudo chown -R "$(whoami)" ~/.npm`

---

## The work still owed

### 1. Ship the bridge inside pew2 — the real blocker

`providers/ggcoder.json` in this repo still runs `ggcoder acp`, a subcommand
that **does not exist**. Anyone cloning pew2 sees GG Coder fail to hand-shake,
exactly as you did. Your machine only works because the file in `~/.pew2`
shadows it.

The bundled manifest cannot simply point at the bridge, because the manifest
must work in the **compiled binary**, where
`packages/daemon/src/acp/ogcoder-bridge.ts` is not a file on disk.

Three ways out, in order of preference:

1. **Bridge as a daemon subcommand** — `pew2 __ogcoder-bridge`, dispatched in
   `packages/daemon/src/cli/index.ts`, manifest runs the running pew2
   executable. Bundles automatically, no new artifact. *Needs:* a reliable
   self-path (`process.execPath` differs between `bun run` and a compiled
   binary) and a hidden command that never shows in `--help`.
2. **A `transport: "rpc"` adapter in the daemon**, alongside `acp`. Cleanest
   conceptually; largest change; the bridge stops being a separate process.
3. **Publish the bridge as its own npm package**, manifest runs it via `npx`.
   Adds a network dependency to a local agent — avoid.

**Recommendation: option 1.** Also fix the manifest's binary name — it should
resolve `ogcoder` before `ggcoder`, the same order `ogcoder-binary.ts` uses.

### 2. Publish the `--resume` fix

`a28cca93` is committed to `rebrand/abukhaled`, unpublished. Until it ships,
resume works only on this machine's `dist/`. Decide whether it goes upstream to
`ggcoder` as well — the bug is in both.

### 3. Fold the Hermes shim into pew2

`~/.pew2/bin/hermes-acp` exists because **Bun's `spawn` hands Python's asyncio a
stdout descriptor it cannot write to.** The handshake times out at 60s with a
message that reads like a flag problem.

This is not Hermes-specific — it will hit **any** Python ACP agent. Better than
shipping a shell script: make the daemon spawn with a plain pipe for stdout when
the manifest asks for it, e.g. `pew: { stdoutPipe: true }`. Then delete the shim.

### 4. Missing manifests

Hermes had no bundled manifest at all; `~/.pew2/providers/hermes.json` is
hand-written. Once the shim is folded in, contribute it to `providers/`.

---

## Traps worth remembering

- **`AgentSession`'s `sessionId` option takes a session *path*, not an id.**
  Passing an id loads nothing and silently starts an empty conversation. This
  is the whole bug behind `--resume`.
- **`abort` in `--rpc` is fatal.** It trips the AbortController the session was
  built with, so the child cannot serve another turn. Cancel therefore kills the
  child; the next prompt respawns it with `--resume`.
- **A child is a session.** `--rpc` takes cwd from `process.cwd()` and opens its
  conversation on spawn, so ACP's per-session `cwd` requires one child each.
- **Thinking level is deliberately not exposed.** `--rpc` accepts it only at
  construction, so a dropdown would have to discard the conversation to apply.
- **launchd's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`.** It contains no pnpm,
  bun, uv or homebrew directory. Anything resolved by bare name works from a
  terminal and fails from the phone — the worst way for this to break. Both
  `ogcoder-binary.ts` and the Hermes shim search explicitly because of this.
- **The daemon starts at login, not boot.** With FileVault on, a reboot parks at
  the login screen and the daemon never starts.

---

## Verifying after any change

```bash
pew2 providers verify ggcoder      # expect: ok
pew2 providers verify hermes       # expect: ok
pew2 doctor                        # expect: agents/service/boot/reach all green
```

`verify` runs in your shell, which has a full PATH — so it **cannot** catch the
launchd-PATH class of bug. Test that explicitly:

```bash
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin ~/.pew2/bin/hermes-acp --help
```

A real end-to-end check is the phone: pull to refresh, open OG Coder, confirm
the model pill lists ~20 models, the sidebar lists past chats, and a resumed
chat can recall something from earlier in that thread.
