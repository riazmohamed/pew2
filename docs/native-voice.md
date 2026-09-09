# Native spoken replies

Implemented on `feat/native-voice-replies`, based on `a9e9ac4a19ab92346160162235d42eb0a08dfe3c`. App-only: no daemon, relay, provider or wire changes. The original pew2 checkout's uncommitted work remains separate; no Brah changes, merges or pushes are part of this implementation.

## Behaviour

- **Spoken replies: off** is the default on every app launch. The switch above the composer enables system text-to-speech. It is not a hands-free conversation mode.
- Replies now read the prose rather than just the first sentence. The current conversation has no agent/project prefix and no routine "On screen" suffix.
- Any conversation that finishes a turn while the app is on screen may speak. Only another conversation's reply names its project. Enabling the switch does not read old messages. Replay repeats the latest reply; backgrounding clears it.
- With the app closed or backgrounded, nothing is spoken: the existing notification is the whole signal. Reopening does not speak what was missed.
- **Stop speaking** interrupts output. Afterwards **Replay reply** repeats it. Turning the switch off also stops output.
- Dictation still inserts an editable draft. It never submits, approves a permission, or sends audio to the coding agent. Typed prompts, offline queuing and ordinary text replies are unchanged.
- Tapping the mic asks playback to stop and starts the recogniser at once; it does not wait for the stop to confirm. An earlier version gated the recogniser on a confirmed stop, and on a Samsung phone the mic then closed the instant it was tapped. Dictation is the feature the app exists for, so it never waits on playback. Playback stays blocked while listening, and a completion during capture is not queued for later.
- Backgrounding and unmounting invalidate pending playback; switching conversations cancels dictation only. Unpairing unmounts the connected app.
- A recogniser session that ends with no result, no error and no stop asked for is reported as a failure that names the service, since which service answered is the whole diagnosis.

## What is read

Speech reuses the per-session opening-text buffer that notifications already keep (`lastText`, live events only). Collection stops once it reaches 6,000 UTF-16 code units; the formatter reads only the first 6,000. Cursor deduplication runs before collection, replay batches never write it, and idle consumes it. The completion key combines session ID and last live sequence number, so duplicate idle is silent.

The formatter uses the installed `markdown-it` to skip fenced/indented code, image descriptions and link destinations, then removes raw URLs and HTML tags. It reads agent prose, not a generated summary. Code-only, image-only or tool-only answers get "response ready, on screen."

Prose longer than 1,500 Unicode characters is cut at a sentence end (or word boundary), followed by "More on screen." Content past the input ceiling is not read, even when code consumes most of that ceiling. Spoken output can omit later caveats and is not a substitute for reviewing consequential instructions.

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

The user confirmed manual dictation and the earlier short cues on Android after restoring the original dictation hook. The longer spoken replies still require device verification.

Automated coverage includes bounded Markdown/Unicode formatting, failure wording, code-only fallback, default-off and explicit replay, foreground gating, duplicate completions, playback suppression during capture, stale playback callbacks, native stop/error/rejection handling and unmount cleanup. Pure tests do not import Expo or React Native; they do not prove microphone behaviour.

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
