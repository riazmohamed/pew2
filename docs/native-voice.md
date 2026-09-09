# Native spoken replies

Implemented on `feat/native-voice-replies`, based on `a9e9ac4a19ab92346160162235d42eb0a08dfe3c`. App-only: no daemon, relay, provider or wire changes. The original pew2 checkout's uncommitted work remains separate; no Brah changes, merges or pushes are part of this implementation.

## Behaviour

- **Spoken cues: off** is the default on every app launch. The switch above the composer enables system text-to-speech. It is not a hands-free conversation mode.
- A cue is a pointer, not a reading: agent and project, the first sentence of the reply (at most 120 characters), then "On screen." It exists so a user who is out and about knows a step finished; the full reply stays on screen.
- Any conversation that finishes a turn while the app is on screen cues, including ones not currently displayed, which is why each cue names its agent and project. Enabling the switch does not read old messages. Replay is explicit and repeats the latest cue; backgrounding clears it.
- With the app closed or backgrounded, nothing is spoken: the existing notification is the whole signal. Reopening does not speak what was missed.
- **Stop speaking** interrupts output. Afterwards **Replay cue** repeats it. Turning the switch off also stops output.
- Dictation still inserts an editable draft. It never submits, approves a permission, or sends audio to the coding agent. Typed prompts, offline queuing and ordinary text replies are unchanged.
- Tapping the mic asks playback to stop and starts the recogniser at once; it does not wait for the stop to confirm. An earlier version gated the recogniser on a confirmed stop, and on a Samsung phone the mic then closed the instant it was tapped. Dictation is the feature the app exists for, so it never waits on playback. Playback stays blocked while listening, and a completion during capture is not queued for later.
- Backgrounding and unmounting invalidate pending playback; switching conversations cancels dictation only. Unpairing unmounts the connected app.
- A recogniser session that ends with no result, no error and no stop asked for is reported as a failure that names the service, since which service answered is the whole diagnosis.
- Native cancellation must acknowledge `end` before another capture or playback is allowed. An unacknowledged cancellation after three seconds fails closed for voice and asks for an app restart; typing remains available.

## What is read

The cue reuses the per-session opening-text buffer that notifications already keep (`lastText`, 2,000 characters, live events only). Existing cursor deduplication runs before it is written, replay batches never write it, and it is consumed on idle. The completion key is the session ID plus the last live sequence number, so a duplicate idle carries no key and is silent.

The formatter parses Markdown with the already installed `markdown-it`. It skips fenced/indented code, image descriptions and link destinations, and removes raw URLs and HTML tags. It speaks the first sentence of actual agent prose, not an invented success summary; a decimal point inside a number is not a sentence end. Code-only, image-only or tool-only answers get “<agent, project>: response ready. On screen.”

A first sentence longer than 120 characters is cut at a word boundary. Spoken output is a pointer only and never a substitute for reviewing the transcript.

## Native requirements and limits

- `expo-speech` is pinned to **14.0.8**, compatible with Expo SDK 54. It requires rebuilding the native app and restarting Metro. No new microphone permission or audio-file storage is introduced by TTS.
- Existing development clients without `ExpoSpeech` show **Speech needs a native rebuild** instead of crashing. This feature intentionally has no web speech fallback.
- Native engine/voice failures leave the response readable and show a plain-language message. A stop failure is reported and keeps completions silent, but never blocks the microphone.
- iOS dictation continues to request on-device recognition. Android continues to use the configured system recognition service; offline recognition/voices depend on the device and installed language assets.
- Expo documents that physical iPhones in silent mode may produce no speech. Volume, Bluetooth/headphone routing, calls, Siri and other audio-session interruptions still require physical-device verification. Interrupted speech is not automatically resumed.
- There is no OpenAI Realtime, ElevenLabs, LiveKit, paid speech service, new credential, or application-level speech network endpoint. Text is passed to the OS speech engine and may be audible to nearby people. Do not enable it for sensitive replies in a shared space.

References: [Expo SDK 54 Speech](https://docs.expo.dev/versions/v54.0.0/sdk/speech/), installed `expo-speech` native module and JS wrapper, and `expo-speech-recognition` 3.1.3 cancellation implementation. The cancellation/generation pattern was also compared with LibreChat's browser text-to-speech hook in the local source corpus; browser behaviour is not evidence of native audio behaviour.

## Verification record

Baseline before implementation: `npm test`, `npm run typecheck`, `npm run lint` all passed after installing the frozen lockfile in this isolated worktree.

Final checks: `npm test` passed (1,234 tests across 117 files); `npm run typecheck`, `npm run lint` and `git diff --check` passed. Temporary simulator harness wiring was removed and the normal app entry point restored.

Automated coverage includes bounded Markdown/Unicode formatting, failure wording, code-only fallback, default-off and explicit replay, current-session/foreground gating, duplicate completions, blocked capture, pending permission cancellation, stale native callbacks, native stop/error/rejection handling and unmount cleanup. Pure tests do not import Expo or React Native.

```sh
bun test packages/app/src/spokenReply.test.ts packages/app/src/transcription.test.ts
npm test
npm run typecheck
npm run lint
```

Runtime checks performed:

- The isolated echo daemon on port 18787 passed every existing `e2e-check.mjs` check: encrypted handshake, session/prompt streaming, completion, selectors, permission approval and image replies. A fresh scratch home and pairing were used, with all non-echo providers disabled. That daemon was stopped afterwards. This verifies transport, not microphone audio.
- iOS prebuild and CocoaPods installation succeeded with `ExpoSpeech` 14.0.8 linked. The normal app entry point also exported successfully as an iOS Hermes bundle.
- An unsigned Debug simulator build succeeded using Xcode 26.2 and worktree-local derived data. No physical device or production installation was replaced.
- A dedicated iOS 26.2 simulator harness exercised the real `ExpoSpeech` module through the playback controller: native `isSpeakingAsync()` observed speech start, then confirmed it stopped. The rendered controls and PASS result were visually checked in `.gg/native-voice-validation.png`. No microphone permission or production pairing was requested. This proves native start/stop, not perceived audio quality or physical-device routing.

### Remaining device checks

These are release gates, not claimed passes:

1. On an isolated physical-device build, dictate onto an existing typed draft; stop, edit and send it to echo. Confirm the same streamed text response and normal permission UI.
2. Enable spoken replies and repeat. Confirm natural speech, Stop, Replay and no audio when off.
3. While speaking, tap the mic; while dictating, finish a turn from another client. Confirm no overlapping capture/playback and no delayed automatic speech.
4. Deny microphone/speech permission; retry after granting it. Background during permission, recording, finalisation and playback. Confirm no late draft changes or audio restart.
5. Switch sessions, open history, reconnect, replay duplicate idle, unpair and remount. Confirm only a new current-session completion can automatically speak.
6. Exercise silent mode, output volume, Bluetooth/headphones, incoming calls, unavailable voices and offline Android recognition. Check text input remains usable after every failure.
7. Check the composer controls with VoiceOver/TalkBack, landscape, large text and the keyboard open. Existing approval and scrolling behaviour must remain unchanged.
