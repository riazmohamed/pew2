# GG Coder + Hermes in pew2

**Updated 2026-08-09.** Read this before touching either provider.

Both ship inside pew2. A fresh clone of this fork gets them; nothing under
`~/.pew2` is required.

---

## GG Coder speaks ACP natively

`providers/ggcoder.json` runs `ogcoder acp`. There is no adapter process.

pew2 carried a bridge for this agent until GG Coder 5.37.0 added `acp` mode.
The bridge is gone, and native is better on every axis measured:

| | bridge | native |
|---|---|---|
| slash commands | 1 | **43** |
| models | 20 | **31** |
| sessions / projects | 187 / 21 | 147 / **20** |
| context meter | yes | yes |
| tool content, diffs | text only | **real diffs** |
| `session/close`, `session/delete` | no | **yes** |

**This depends on a local gg-framework build.** Published 5.37.0 ignores the
`cwd` a client sends with `session/new` and uses the agent process's own
directory instead. Under a daemon that is `/`, which fails as `mkdir '/.gg'` —
and where the process directory is writable it silently runs the session
against a project the user never chose. Fixed in gg-framework `07a8090e`, which
is **committed but not published**: a stock `ogcoder` from npm still has it.

The manifest id must stay `ggcoder`. The daemon keys history hydration off it
(`acp/messageCounts.ts`, `index.ts`).

## Hermes needs `stdoutPipe`

Bun's `spawn` hands a child a stdout descriptor Python's asyncio cannot write
to: the agent logs `initialize`, its reply never arrives, and the session dies
60s later reporting a handshake timeout — which names the wrong cause entirely.

Measured, not assumed: the same agent replies immediately under Node, is silent
under Bun, and replies under Bun through `sh -c '… | cat'`. `pew.stdoutPipe`
does exactly that. It will be needed by **any** Python ACP agent.

---

## Will it keep working?

Reboots, daemon restarts, phone reconnects, roaming and moving this repo are all
fine.

| # | Condition | What breaks it | Symptom on the phone |
|---|-----------|----------------|----------------------|
| 1 | `bun` keeps Full Disk Access | Revoking it; **replacing the bun binary may silently drop the grant** | Every agent hangs, daemon logs stay empty |
| 2 | `ogcoder` keeps pointing at the local build | `npm i -g` a published ogcoder | Sessions run in the wrong directory, or fail with `mkdir '/.gg'` |
| 3 | The agent stays installed | Uninstalling `ogcoder` / `hermes` | The agent drops off the list, honestly |

## Agents switched off

`cline`, `gemini-cli`, `opencode`, `qwen-code` — in `~/.pew2/disabled.json`.
Bring one back with `pew2 providers enable <id>`.

---

## The work still owed

### 1. Publish gg-framework

Two fixes are committed and unpublished, and this fork depends on both:

- `a28cca93` — `--rpc --resume` was parsed and dropped.
- `07a8090e` — ACP `session/new` ignored the client's `cwd`.

The second affects every ACP client of GG Coder, not just pew2.

### 2. A permission hook — the one real safety gap

GG Coder has **no approval concept anywhere**: not in `acp-mode.ts`, not in
`rpc-mode.ts`, not in `agent-session.ts`. Every edit and shell command runs
unattended, so from the phone you cannot stop a destructive tool call. Claude
Code can.

Partly mitigated in gg-framework `ce990894`: recursive force-removal outside the
workspace is now refused, matching the write guard's existing boundary and
opt-in. That closes the worst accident, not the general gap.

The general fix is bigger than it looks. ACP has `session/request_permission`,
so the protocol supports it — but `gg-agent` has five dependents, no policy
exists to extend, and a blocked turn needs a timeout and a default (where
"default allow" quietly restores today's behaviour at the worst moment). Decide
the policy before writing code.

### 3. Clean up the npm cache

218 root-owned files in `~/.npm/_cacache`, from an old `sudo npm`, break `npx`.
Worked around with `cache=~/.npm-pew2-cache` in `~/.npmrc`. Real fix:
`sudo chown -R "$(whoami)" ~/.npm`

---

## Traps worth remembering

- **ACP `session/new` carries the project directory.** An agent that ignores it
  and uses `process.cwd()` works when a human runs it in a project and silently
  works in the wrong place under a daemon.
- **`AgentSession`'s `sessionId` option takes a session *path*, not an id.**
  Passing an id loads nothing and silently starts an empty conversation.
- **The daemon calls `session/list` with no arguments** and folds the result
  into the app's project picker. An agent that scopes that call to one directory
  leaves the picker empty forever.
- **`pew2 service install` bakes the installing shell's PATH into the plist.**
  It is a snapshot: an agent installed afterwards is invisible to the running
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

`verify` runs in your shell, which has a full PATH, so it cannot catch the
launchd-PATH class of bug. Test that explicitly:

```bash
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin ogcoder acp </dev/null
```

A real end-to-end check is the phone: pull to refresh, open GG Coder, confirm
the folder picker lists your projects, the model pill lists ~31 models, the
sidebar lists past chats, and a resumed chat recalls something from earlier in
that thread.
