# Live preview roadmap

Status: deferred R&D. Resume after the current implementation workstreams are integrated.
Recorded: 9 September 2026.

## Goal

See and interact with the website or app being built from pew2, without switching away from the coding conversation or building blind. The computer continues to run the development server or simulator; the phone displays the result.

## Worktree checkpoint

Both worktrees pointed to commit `a9e9ac4a19ab92346160162235d42eb0a08dfe3c` when inspected. Both contained uncommitted work. Recheck their state before resuming; this is a checkpoint, not a current-state guarantee.

| Worktree | Branch | Observed work |
| --- | --- | --- |
| `../pew2` | `riaz_pew2` | Preview-related app and daemon files, protocol changes, and chat/UI changes. |
| Current checkout, `pew2-native-voice` | `feat/native-voice-replies` | Dictation capture, spoken replies, native speech controls, and dependency changes. |

Both modify `packages/app/App.tsx`, `packages/app/src/ui/ComposerDock.tsx`, and `packages/app/src/useDaemon.ts`. Integrate deliberately rather than starting another implementation against these files now.

The other worktree already contains:

- `packages/app/src/preview.ts` and its tests.
- `packages/app/src/ui/PreviewSheet.tsx`.
- `packages/daemon/src/preview.ts` and its tests.
- Related changes in the daemon handler and protocol.

The inspected app helper rewrites desktop loopback URLs to LAN addresses, ranks discovered servers, and supplies snapshot cache keys. This indicates existing preview work, not proof that the complete feature works. No runtime verification or security review was performed during this checkpoint.

## Recommended sequence

### 1. Finish and integrate existing work

- Recheck `git worktree list` and the status of both worktrees.
- Finish and test voice and existing preview/UI work independently.
- Integrate only once their changes are ready, resolving the three shared app files carefully.
- Keep voice controls, chat state, and preview state independent.

Acceptance: both workstreams retain their behaviour after integration; no uncommitted work is discarded or overwritten.

### 2. Validate the existing preview baseline

- Trace the existing server-discovery, link-opening, and snapshot paths before adding anything.
- Test a real development server from a physical phone on the same Wi-Fi.
- Verify desktop `localhost` links resolve to the intended desktop server, not the phone.
- Verify snapshot behaviour remotely, including unavailable servers, capture failures, size limits, and reconnects.
- Clearly distinguish a static screenshot from an interactive page.

Acceptance: the user can find the intended project preview, open it where reachable, and understand when only a snapshot is available. Existing tests plus device checks demonstrate the baseline rather than assuming it works.

### 3. Add a dedicated interactive website preview

- Reuse the baseline rather than creating a second preview subsystem.
- Add an embedded browser surface only if the existing browser flow is insufficient.
- Keep chat and preview one tap apart, preserving conversation and page state where practical.
- Provide refresh, loading, failure, and disconnected states.
- Consider attaching a preview screenshot to the conversation for visual feedback after the core flow works.

Acceptance: page interactions and development-server live reload work; returning to chat preserves the draft; keyboard, rotation, safe areas, and navigation behave correctly on supported devices.

### 4. Support secure remote website access

- Design authenticated access to explicitly selected development servers. Do not expose arbitrary desktop ports or weaken pairing security.
- Account for HTTP assets, WebSocket upgrades used by live reload, redirects, cookies, and reconnects.
- Preserve the existing relay's opaque-frame trust model. A paired connection alone does not make a WebView able to load desktop HTTP URLs.
- Keep preview traffic bounded and isolated so it cannot stall prompts, permissions, or transcript replay.
- Make wire additions compatible with older apps and daemons; they ship separately.

Acceptance: preview interaction and live reload work off the LAN; unauthorised access is rejected; disconnection recovers without losing chat state; security and resource limits are tested.

This is an architectural decision point. Choose the transport after inspecting real implementations and the integrated baseline, not from the earlier rough estimate.

### 5. Explore native simulator streaming separately

- Start with view-only streaming from a simulator running on the computer.
- Treat simulator capture, video transport, and the phone viewer as separate components.
- Add touch and keyboard forwarding only after streaming is reliable.
- A WebView is not an iOS or Android simulator. WebRTC supplies transport primitives, not the full simulator solution.

Acceptance: the supported host/platform combination is explicit; viewing has measured latency and resource use; backgrounding, disconnecting, and closing the preview release resources. Interactive control must not inject input into unrelated desktop windows.

## Research corpus already available

Tag: `pew2-live-preview`. All four repositories were successfully indexed. These are implementation references, not installed dependencies or validated designs.

| Repository | Research use |
| --- | --- |
| https://github.com/react-native-webview/react-native-webview | Embedded browser lifecycle and navigation controls in React Native. |
| https://github.com/stablyai/orca | Coding-agent product and mobile companion workflows. |
| https://github.com/react-native-webrtc/react-native-webrtc | React Native video reception and data channels. |
| https://github.com/shaobeichen/dsh-pocket | LAN and tunnel-based phone access to a desktop agent interface. |

Suggested first corpus search: literal `onShouldStartLoadWithRequest` in `react-native-webview/react-native-webview`, then read matching code. Verify licences and fit before adapting code. Do not copy another project's authentication model without review.

## Planning ranges, not commitments

Earlier discussion estimated the following for one experienced developer, including testing:

| Scope | Rough range |
| --- | --- |
| Same-Wi-Fi website preview from scratch | 2–4 days |
| Secure remote website preview | 1–2 weeks total |
| View-only simulator streaming | Another 1–2 weeks |
| Simulator touch, typing, and reliable recovery | Another 2–4 weeks |

Re-estimate after validating the existing preview work. These ranges do not establish technical feasibility for every framework or simulator, and exclude App Store review time. Native app changes require a new app build; daemon/protocol changes follow their own release path.

## Resume here

Check both worktrees, identify what has shipped or merged, and validate the existing preview baseline. Then choose the smallest missing website-preview milestone. Do not begin simulator streaming or duplicate the existing preview implementation by default.
