# Native spoken replies and hands-free

App-only changes on `feat/native-voice-replies`. The longer-reply conversion was pushed as `34daba1`. No daemon restart, relay deployment, wire change or re-pairing is required. Keep the previous working Android APK for rollback.

## Manual voice and spoken replies

- **Spoken replies** defaults off on each launch. Enabling it does not read old messages. **Replay reply** repeats the latest observed reply; **Stop speaking** interrupts it. Backgrounding clears replay and never resumes missed speech.
- Replies read prose, not only the first sentence. The active conversation has no agent/project prefix or routine “On screen” suffix. With hands-free off, another conversation's completion may speak while the app is foregrounded and names its project.
- With **Hands-free off**, the mic is still tap-to-dictate: text goes into the editable composer, and sending is manual. Manual capture does not await a TTS stop promise. The transcript merge algorithm and recogniser selection/options are unchanged.
- Earlier APKs regressed dictation, and the user confirmed it worked after the original hook was restored. The phone was not instrumented during that regression; neither the recogniser nor the TTS stop path was proven to be its cause.

## Hands-free: foreground, turn-taking only

1. While stationary, open an existing live conversation with an online connection. Finish any working turn or approval, send or clear the draft, and remove attachments.
2. Enable **Spoken replies**, then **Hands-free**. The control explains why activation is unavailable. Microphone permission is required. A permission dialog or phone interruption pauses the loop; resume deliberately afterwards.
3. Speak. After **two seconds without transcript activity**, the app shows **Sending soon** for a **three-second cancellation window**. Recognition continues during that window. New recognition activity resets both delays.
4. The app then asks recognition to finish and waits for native `end`, including final text revisions. `isFinal` never triggers sending. If no native end arrives within three seconds, the loop pauses and keeps the draft.
5. The current draft is sent once through the existing send path with an **online-only** policy. A refused send preserves the draft and pauses. Automatic prompts never enter the offline outbox; manual offline queuing is unchanged.
6. The microphone remains closed while the coding agent works and while the expected reply is spoken. Only successful natural playback completion starts the next listening cycle. A missing/empty live reply, audio error, Stop or Replay pauses instead.

This is a **transcript-inactivity heuristic, not acoustic silence detection**. Recognition latency can make a pause appear longer than it is. Review the draft during testing. This version does not offer verified VAD, echo cancellation, barge-in (talking over a reply), wake words, background capture or locked-screen listening.

**Pause / Cancel send** stops the loop and retains unsent text. Saying exactly **“stop listening”** as a standalone recognised utterance disables hands-free without sending that command. It is recognised only while the microphone is listening, not during playback or the agent's work. Unsent text, including that command if it reached the draft, remains editable.

Background/lock, connection loss, session/provider/project changes, open menus or permission UI, manual editing/sending/mic use, attachments, disabling speech and unmount all pause/cancel automatic work. There is no automatic resume on reconnect or return to foreground. An empty listening cycle is limited to 30 seconds. When off, no loop timer keeps the mic alive.

Hands-free owns automatic audio while enabled: other conversations retain ordinary notifications but do not speak into its capture. History and duplicate completions cannot start listening. Approvals remain separate touch actions; there is no voice permission resolver.

Do not treat this as a driving-safety feature. Set up, test, inspect instructions and approve permissions only while stationary.

## Voice, content and privacy limits

The voice is still the configured **system TTS voice**, not a new paid voice engine. Longer prose improves content, not voice quality. There are no new dependencies, API subscriptions, keys or application-level speech endpoints. No audio recording is saved by this feature.

The existing recogniser may use its vendor's network service, depending on the OS, selected service and installed language assets. Recognised text is placed in the draft and, when sent, follows the existing coding-agent prompt route. Speech output is audible to people nearby. Do not enable it for sensitive conversations in shared spaces.

Speech reads the first 6,000 UTF-16 code units of the live response buffer. Markdown parsing omits fenced/indented code, images and link destinations, then removes raw URLs and HTML tags. Prose beyond 1,500 Unicode characters is cut at a sentence or word boundary with “More on screen.” Content past the input limit and later caveats can be omitted. In manual spoken-reply mode, code-only/image-only replies receive a short on-screen pointer. Speech is not a substitute for reviewing consequential instructions.

Bluetooth/headphone routing, recognition latency, incoming calls, permission interruptions and system voice availability require physical-device verification. A compiled APK and pure tests cannot establish native audio reliability.

## Implementation and checks

`handsFree.ts` owns states, bounded timers, generation/context guards and exactly-once send ownership; `ui/useHandsFree.ts` binds it to AppState, dictation and playback. Draft text stays in `ComposerDock`, whose versioned imperative handle updates synchronously so final native text can be sent before another React render. Online-only refusal happens in `useDaemon` before outbox or optimistic-turn mutation.

Playback outcomes carry completion/session IDs and distinguish natural `done`, `stopped` and `error`. Stale callbacks are invalidated. Manual dictation remains independent of playback stop acknowledgement.

Patterns were compared with LibreChat's `useSpeechToTextBrowser.ts` (opt-in delayed send and timer cleanup) and `useTextToSpeechBrowser.ts` (voice availability and explicit lifecycle outcomes). Unlike its browser auto-send, this app cannot trust `isFinal` as a boundary and must additionally guard approvals, session changes and offline queuing. Installed Expo module types were read for native start/result/end/stop/abort semantics.

Run checks directly:

```sh
npm test
npm run typecheck
npm run lint
git diff --check
```

New tests exercise two complete controller cycles, the real playback/controller pairing, empty speech, timing resets, finalisation timeout, final revisions, cancellation, permission/start rejection, stale contexts, duplicate completions, playback outcomes and offline delivery policy. Existing transcript and playback assertions remain. These are software checks, not Android acceptance.

## Build and verification record, 9 September 2026

- Direct `npm test`: **1,265 pass, 0 fail** across 118 files. Direct typecheck, lint and diff checks passed. Added tests assert the new behaviour; existing assertions were retained.
- Local EAS **23.2.0**, existing `apk` profile, Android Studio JDK **21.0.8** and existing Android SDK. Final build process exited **0**; Gradle reported success in 4m 31s. No global Gradle configuration was changed.
- Final handoff: `~/Desktop/pew2-hands-free-20260909-r2.apk`, **105,843,621 bytes**. SHA-256: `6082d5bd645acc2a9ba387bc02ab1d45f37dda3a0014d67416d14416f7a338ef`. The earlier hands-free APK without `-r2` is superseded; do not use it for acceptance.
- APK signatures verified and the signing identity matches the previous working APK. Package `io.github.kenkaiii.pew2`, versionCode `1`. The final hands-free revision was found in the bundled Android code.
- Rollback `~/Desktop/pew2-native-voice.apk` remains unchanged, SHA-256 `4cc79843118f0ef05c2e878eae9f1e327681499129c6e211ba579ad6bb81d08d`.
- Expo Doctor retains the **same four pre-existing failed checks** seen in the previous APK's build log: static config schema annotations, dynamic/static config relationship, intentional Metro overrides, and SDK patch-version recommendations. EAS continued and built successfully. No checks were suppressed and no dependency versions were changed.
- `adb devices` found no connected phone. No native audio harness or physical-device test was run for this revision. The installed paired app was not replaced by the build.

## Android acceptance while stationary

Install **`pew2-hands-free-20260909-r2.apk`** over the existing native app. Do not uninstall or re-pair. The prior working APK remains the rollback artifact.

- [ ] Conversation list and existing relay pairing survive the update.
- [ ] With hands-free off, manual dictation still appends to typed text, stops, edits and sends normally.
- [ ] Enable once and complete **two full listen → send → speak → listen turns** without touching mic/send.
- [ ] New speech during “Sending soon” resets the window; Cancel send and “stop listening” prevent submission.
- [ ] No speech pauses after 30 seconds; permission denial/interruption and missing native end retain drafts without retries.
- [ ] Other conversation completions do not speak during capture; Stop/Replay do not reopen the mic.
- [ ] An agent approval pauses the loop. Spoken “yes” never resolves it.
- [ ] Mobile-data interruption, changing conversation/project, screen lock and foreground return do not auto-resume or queue a voice prompt.
- [ ] Check output volume, Bluetooth/headphones, call interruption, TalkBack, large text, landscape and keyboard-open controls.

The user previously confirmed manual dictation and short cues. **The longer replies and hands-free loop remain unverified on the physical Android device until these checks are reported.**
