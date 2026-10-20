/**
 * Pew rings a phone the system cannot ring (Android): the tone, the banner
 * when the app is in the background, and the incoming-call card.
 *
 * The daemon decides when (`voice.ring`, see `androidRing.ts`). Answering
 * goes the way a CallKit answer does (`onAnswer`, which starts the call once
 * the daemon is reachable); declining and missing tell the daemon, which holds
 * the next ring off. A tapped banner opens the call through `onVoiceRequest`,
 * like an iPhone's call push.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import type { wire } from "@pew2/protocol";
import { canRing } from "../../modules/pew-call";
import { answeredRing, claimRing, nativeRinger, ringClaimed, stopNativeRing, takeEndedRings } from "../../modules/pew-ring";
import { RING_MS, readRing, ringAction, ringEnded, type IncomingRing } from "../androidRing";
import { dismissRing, notifyRing } from "./notifier";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RINGTONE = require("../../assets/ringtone.wav") as number;

/**
 * With the app in the background, how long the native ring (the daemon's
 * data-only push, `modules/pew-ring`) gets to take a ring before the app
 * rings it itself: the push and the socket carry the same ring.
 */
const NATIVE_GRACE_MS = 4_000;

/** Ring answers already acted on: `getInitialURL` repeats the cold-start link on every mount. */
const answeredRings = new Set<string>();

interface Options {
  post: (message: unknown) => boolean;
  online: boolean;
  consented: boolean;
  /** A call is connecting or live. */
  callActive: boolean;
  onAnswer: (focus: string | undefined) => void;
}

export function useAndroidRing({ post, online, consented, callActive, onAnswer }: Options) {
  const [incoming, setIncoming] = useState<IncomingRing | undefined>(undefined);
  /** Declines and misses not yet told to the daemon (the socket may be down). */
  const [unsent, setUnsent] = useState<wire.VoiceEnd[]>([]);
  const current = useRef<IncomingRing | undefined>(undefined);
  const player = useRef<AudioPlayer | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const banner = useRef<Promise<string | undefined> | undefined>(undefined);
  const opts = useRef({ consented, callActive, onAnswer });
  opts.current = { consented, callActive, onAnswer };

  /** Silence the tone, take the banner down, clear the card. */
  const stop = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    try {
      player.current?.pause();
      player.current?.remove();
    } catch {
      // Already released.
    }
    player.current = undefined;
    void banner.current?.then(dismissRing);
    banner.current = undefined;
    current.current = undefined;
    setIncoming(undefined);
  }, []);

  const end = useCallback(
    (reason: "declined" | "missed") => {
      const ring = current.current;
      stop();
      if (ring) setUnsent((list) => [...list, ringEnded(ring, reason)]);
    },
    [stop],
  );

  /** The tone, the card, and in the background the banner. */
  const ringHere = useCallback(
    (ring: IncomingRing, inBackground: boolean) => {
      stop();
      current.current = ring;
      setIncoming(ring);
      try {
        const ringer = createAudioPlayer(RINGTONE);
        ringer.loop = true;
        ringer.play();
        player.current = ringer;
      } catch {
        // A build without the audio module still shows the card and banner.
      }
      if (inBackground) banner.current = notifyRing(ring);
      timer.current = setTimeout(() => end("missed"), RING_MS);
    },
    [stop, end],
  );

  /** Every opened daemon frame; only `voice.ring` matters here. */
  const onFrame = useCallback(
    (message: unknown) => {
      const ring = readRing(message);
      if (!ring) return;
      const action = ringAction({ systemRings: canRing, consented: opts.current.consented, callActive: opts.current.callActive });
      if (action === "ignore") return;
      const inBackground = AppState.currentState !== "active";
      if (action === "banner") {
        // Not yet agreed to calls: the banner only, whose tap asks first.
        if (inBackground) void notifyRing(ring);
        return;
      }
      if (inBackground && nativeRinger) {
        // The native ring has it unless it fails to arrive: ring here only then.
        setTimeout(() => {
          if (ringClaimed(ring.ringId) || !claimRing(ring.ringId)) return;
          ringHere(ring, AppState.currentState !== "active");
        }, NATIVE_GRACE_MS);
        return;
      }
      if (!claimRing(ring.ringId)) return;
      ringHere(ring, inBackground);
    },
    [ringHere],
  );

  // Answer on the native ring's notification: it opens `pew2://ring/answer`.
  useEffect(() => {
    if (!nativeRinger) return;
    const handle = (url: string | null) => {
      const answered = url ? answeredRing(url) : undefined;
      if (!answered || answeredRings.has(answered.ringId)) return;
      answeredRings.add(answered.ringId);
      stopNativeRing();
      stop();
      opts.current.onAnswer(answered.focus);
    };
    void Linking.getInitialURL()
      .then(handle)
      .catch(() => {});
    const subscription = Linking.addEventListener("url", ({ url }) => handle(url));
    return () => subscription.remove();
  }, [stop]);

  // Declines and misses on the native ring, for the daemon: on start and on every return to the app.
  useEffect(() => {
    if (!nativeRinger) return;
    const collect = () => {
      const ended = takeEndedRings();
      if (ended.length > 0) setUnsent((list) => [...list, ...ended.map((item) => ({ t: "voice.end" as const, callId: item.ringId, reason: item.reason }))]);
    };
    collect();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") collect();
    });
    return () => subscription.remove();
  }, []);

  const answer = useCallback(() => {
    const ring = current.current;
    stop();
    opts.current.onAnswer(ring?.focus);
  }, [stop]);
  const decline = useCallback(() => end("declined"), [end]);

  // A call started some other way (the banner tapped, Talk pressed): stop ringing.
  useEffect(() => {
    if (callActive) stopNativeRing();
    if (callActive && current.current) stop();
  }, [callActive, stop]);

  // Tell the daemon about declines and misses once it can hear.
  useEffect(() => {
    if (!online || unsent.length === 0) return;
    const left = unsent.filter((message) => !post(message));
    if (left.length !== unsent.length) setUnsent(left);
  }, [online, unsent, post]);

  useEffect(() => stop, [stop]);

  return { incoming, onFrame, answer, decline };
}
