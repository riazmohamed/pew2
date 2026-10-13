/**
 * A live voice conversation with GPT-Live, over WebRTC.
 *
 * The phone is only microphone, speaker, captions and controls: the daemon
 * holds the OpenAI key, exchanges this phone's SDP offer for an answer, and
 * runs every coding job the assistant hands over. What lives here is what the
 * pure reducer cannot own: the peer connection, the mic stream, the data
 * channel, audio routing and timers.
 *
 * Every path out tears all of that down: hanging up, an error, the daemon
 * saying the call closed, and unmount. A mic left open shows the orange
 * indicator with nothing on screen to explain it, which reads as spying.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { mediaDevices, RTCPeerConnection, type MediaStream } from "react-native-webrtc";

type RTCDataChannel = ReturnType<RTCPeerConnection["createDataChannel"]>;
import InCallManager from "react-native-incall-manager";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { startVoiceCallService, stopVoiceCallService } from "../../modules/voice-call-service";
import { PermissionsAndroid, Platform } from "react-native";
import {
  initialVoiceState,
  readDataChannelEvent,
  shouldRingForTurn,
  voiceOrb,
  voiceReducer,
  voiceSessionToOpen,
  voiceStatusLine,
  voiceUsageLine,
  type VoiceOrb,
  type VoiceState,
} from "../voiceSession";
import type { Status, VoiceFrame } from "../useDaemon";
import type { wire } from "@pew2/protocol";
import { haptics } from "./haptics";

const ICE_TIMEOUT_MS = 10_000;
/** Ring this long before going quiet; the offer itself stays until acted on. */
const RING_MS = 30_000;
/** An unanswered incoming offer gives up after this. */
const INCOMING_EXPIRE_MS = 120_000;
/** From tapping to `session.started`; past this the call is abandoned. */
const CONNECT_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;
const KEEP_AWAKE_TAG = "pew2-voice";
/**
 * A UK ringing tone, played while the call connects, so "Connecting" sounds
 * like a call being placed rather than an app thinking. Looped until the
 * assistant picks up; stopped on every exit path.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RINGTONE = require("../../assets/ringtone.wav") as number;
const UNREACHABLE = "Your computer isn't reachable right now, so a voice conversation can't start.";

export interface UseVoiceOptions {
  status: Status;
  voice?: { available: boolean; reason?: string };
  sendVoice: (message: wire.VoiceStart | wire.VoiceStop) => boolean;
  setVoiceListener: (listener: ((message: VoiceFrame) => void) | undefined) => void;
  /** Context handed to the daemon so the assistant's work lands somewhere sensible. */
  sessionId?: string;
  providerId?: string;
  cwd?: string;
  providerName: (id: string | undefined) => string;
  /** Stop dictation: two things must never hold the mic at once. */
  onBeforeStart: () => void;
  /** The assistant's work is in another conversation: show it. */
  onOpenSession: (sessionId: string) => void;
  onSessionShown?: string;
  onMessage: (message: string) => void;
}

export interface Voice {
  /** Undefined when the daemon is too old for voice: show no button at all. */
  offered: boolean;
  state: VoiceState;
  /** Whether the voice screen should be up. */
  open: boolean;
  /**
   * A finished agent turn offering itself as a call, while the ring sounds.
   * Accepting starts a voice call briefed on that conversation.
   */
  incoming?: IncomingCall;
  /** The quiet "4:12 · about 21p" line for the call screen. */
  usageLine: string;
  /** Offer a finished turn as an incoming call. Ignored while a call is live. */
  offerIncoming: (turn: IncomingCall) => void;
  acceptIncoming: () => void;
  declineIncoming: () => void;
  /** A call is running, even minimized: the banner shows on this. */
  active: boolean;
  minimized: boolean;
  orb: VoiceOrb;
  statusLine: string;
  start: () => void;
  end: () => void;
  toggleMute: () => void;
  /** Shrink the call to the banner so the chat underneath can be watched. */
  minimize: () => void;
  /** Bring the full voice screen back up. */
  expand: () => void;
  /** Close the screen after an error. */
  dismiss: () => void;
}

/** A finished turn ringing the phone, before it becomes a call. */
export interface IncomingCall {
  sessionId: string;
  agentName?: string;
  folder?: string;
}

interface Call {
  stream?: MediaStream;
  pc?: RTCPeerConnection;
  channel?: RTCDataChannel;
  requestId: string;
  liveSessionId?: string;
  timers: ReturnType<typeof setTimeout>[];
  audioStarted: boolean;
  ringer?: AudioPlayer;
  /** Resolves the wait for `session.closed` when hanging up. */
  onClosed?: () => void;
  done: boolean;
  /** The conversation already switched to, so a stream of statuses does not re-open it. */
  opened?: string;
}

export function useVoice(options: UseVoiceOptions): Voice {
  const [state, dispatch] = useReducer(voiceReducer, initialVoiceState);
  const [now, setNow] = useState(() => Date.now());
  const [incoming, setIncoming] = useState<IncomingCall | undefined>(undefined);
  const incomingTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const incomingRinger = useRef<AudioPlayer | undefined>(undefined);
  const call = useRef<Call | undefined>(undefined);
  const counter = useRef(0);
  const opts = useRef(options);
  opts.current = options;

  /** Release everything this call holds. Safe to call twice. */
  const teardown = useCallback((target: Call | undefined) => {
    if (!target || target.done) return;
    target.done = true;
    for (const timer of target.timers) clearTimeout(timer);
    target.timers = [];
    target.stream?.getTracks().forEach((track) => track.stop());
    try { target.channel?.close(); } catch { /* already closed */ }
    try { target.pc?.close(); } catch { /* already closed */ }
    stopRinger(target);
    if (target.audioStarted) InCallManager.stop();
    stopVoiceCallService();
    void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
    if (call.current === target) call.current = undefined;
  }, []);

  const fail = useCallback((target: Call | undefined, message: string) => {
    if (!target || target.done) return;
    if (target.liveSessionId) opts.current.sendVoice({ t: "voice.stop", liveSessionId: target.liveSessionId });
    teardown(target);
    dispatch({ type: "fail", message });
    haptics.failed();
  }, [teardown]);

  // One listener for the daemon's voice frames, matched to this phone's call.
  useEffect(() => {
    const { setVoiceListener } = opts.current;
    setVoiceListener((message) => {
      const current = call.current;
      if (!current) return;
      if (message.t === "voice.answer") {
        if (message.requestId !== current.requestId) return;
        dispatch({ type: "answer", requestId: message.requestId, liveSessionId: message.liveSessionId, voiceRatePerMinuteUsd: message.voiceRatePerMinuteUsd, error: message.error });
        if (message.error || !message.liveSessionId || !message.sdp) {
          teardown(current);
          haptics.failed();
          return;
        }
        current.liveSessionId = message.liveSessionId;
        current.pc?.setRemoteDescription({ type: "answer", sdp: message.sdp }).catch(() => {
          fail(current, "The voice service sent an answer this phone could not use.");
        });
        return;
      }
      if (!current.liveSessionId || message.liveSessionId !== current.liveSessionId) return;
      dispatch({ type: "status", status: message });
      const target = voiceSessionToOpen(message, current.liveSessionId, opts.current.onSessionShown);
      if (target && target !== current.opened) {
        current.opened = target;
        opts.current.onOpenSession(target);
      }
      if (message.state === "agent_waiting") haptics.attention();
      if (message.state === "closed" || message.state === "error") {
        current.onClosed?.();
        teardown(current);
      }
    });
    return () => {
      setVoiceListener(undefined);
      teardown(call.current);
      for (const timer of incomingTimers.current) clearTimeout(timer);
      const ringer = incomingRinger.current;
      if (ringer) {
        try { ringer.pause(); } catch { /* gone */ }
        try { ringer.remove(); } catch { /* gone */ }
      }
    };
  }, [teardown, fail]);

  const live = state.phase === "live";
  // Re-render while live so "speaking" fades when the assistant's words stop.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(timer);
  }, [live]);

  const start = useCallback((targetSessionId?: string) => {
    const o = opts.current;
    if (call.current) return;
    if (o.voice && !o.voice.available) {
      o.onMessage(o.voice.reason ?? "Voice isn't set up on your computer yet.");
      haptics.warned();
      return;
    }
    if (o.status !== "online") {
      o.onMessage(UNREACHABLE);
      haptics.warned();
      return;
    }
    o.onBeforeStart();
    const requestId = `voice:${Date.now()}:${++counter.current}`;
    const current: Call = { requestId, timers: [], audioStarted: false, done: false };
    call.current = current;
    dispatch({ type: "start", requestId });
    haptics.sent();
    try {
      const ringer = createAudioPlayer(RINGTONE);
      ringer.loop = true;
      ringer.play();
      current.ringer = ringer;
    } catch {
      // A build without the audio module still makes the call, silently.
    }
    current.timers.push(setTimeout(() => {
      fail(current, "The voice conversation took too long to start.");
    }, CONNECT_TIMEOUT_MS));

    // Keeps the screen from dimming mid-sentence while the phone is in hand.
    // Locking it is fine: on Android the foreground service started below
    // keeps the microphone, and iOS keeps going via UIBackgroundModes audio.
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);

    void (async () => {
      // Android 12+ will not route to a Bluetooth headset without this
      // runtime grant. Refusing it only means the loudspeaker is used.
      if (Platform.OS === "android" && Number(Platform.Version) >= 31) {
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT).catch(() => undefined);
      }
      let stream: MediaStream;
      try {
        stream = await mediaDevices.getUserMedia({ audio: true, video: false });
      } catch {
        fail(current, "Microphone access is off. Turn it on for pew2 in Settings to talk.");
        return;
      }
      if (current.done) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      current.stream = stream;
      // Now, while the app is certainly on screen and the microphone is
      // granted: Android 14 refuses a microphone service started any later,
      // and without it a locked screen silences the call.
      startVoiceCallService("Voice conversation", "pew2 is listening. Tap to return.");
      const pc = new RTCPeerConnection({});
      current.pc = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      // Created before the offer, or the offer carries no data channel.
      const channel = pc.createDataChannel("oai-events");
      current.channel = channel;
      channel.onmessage = (event: { data?: unknown }) => {
        if (current.done || typeof event.data !== "string") return;
        const parsed = readDataChannelEvent(event.data);
        if (!parsed) return;
        if (parsed.kind === "started") {
          for (const timer of current.timers) clearTimeout(timer);
          current.timers = [];
          stopRinger(current);
          // Routed only once audio is flowing: WebRTC sets its own voice-chat
          // mode as the audio unit starts, which would put the reply in the
          // earpiece. Video-chat mode defaults to the loudspeaker and still
          // yields to AirPods or a wired headset when one is connected.
          if (!current.audioStarted) {
            InCallManager.start({ media: "video", auto: true });
            current.audioStarted = true;
          }
          dispatch({ type: "started", now: Date.now() });
          haptics.finished();
        } else if (parsed.kind === "transcript") {
          dispatch({ type: "transcript", speaker: parsed.speaker, delta: parsed.delta, now: Date.now() });
        } else if (parsed.kind === "closed") {
          current.onClosed?.();
        } else {
          fail(current, parsed.message);
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") fail(current, "The voice connection dropped.");
      };

      try {
        const offer = await pc.createOffer({});
        await pc.setLocalDescription(offer);
        await iceGathered(pc, ICE_TIMEOUT_MS);
      } catch {
        fail(current, "This phone could not set up the voice connection.");
        return;
      }
      if (current.done) return;
      const sdp = pc.localDescription?.sdp;
      if (!sdp) {
        fail(current, "This phone could not set up the voice connection.");
        return;
      }
      const latest = opts.current;
      const sent = latest.sendVoice({
        t: "voice.start",
        requestId,
        sdp,
        sessionId: targetSessionId ?? latest.sessionId,
        providerId: latest.providerId,
        cwd: latest.cwd,
      });
      if (!sent) fail(current, UNREACHABLE);
    })();
  }, [fail]);

  const end = useCallback(() => {
    const current = call.current;
    if (!current) {
      dispatch({ type: "reset" });
      return;
    }
    dispatch({ type: "end" });
    haptics.tap();
    const finish = () => {
      if (current.liveSessionId) opts.current.sendVoice({ t: "voice.stop", liveSessionId: current.liveSessionId });
      teardown(current);
      dispatch({ type: "closed" });
    };
    const channel = current.channel;
    if (channel?.readyState === "open") {
      current.onClosed = finish;
      // Muting first, so nothing said while it closes is sent.
      current.stream?.getAudioTracks().forEach((track) => { track.enabled = false; });
      try { channel.send(JSON.stringify({ type: "session.close" })); } catch { finish(); return; }
      current.timers.push(setTimeout(finish, CLOSE_TIMEOUT_MS));
    } else {
      finish();
    }
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const current = call.current;
    if (!current?.stream) return;
    const muted = !state.muted;
    current.stream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    if (current.channel?.readyState === "open") {
      try {
        current.channel.send(JSON.stringify({ type: muted ? "session.input_audio.mute" : "session.input_audio.unmute" }));
      } catch { /* the track is already disabled, which is what matters */ }
    }
    dispatch({ type: "mute", muted });
    haptics.select();
  }, [state.muted]);

  const dismiss = useCallback(() => {
    teardown(call.current);
    dispatch({ type: "reset" });
  }, [teardown]);

  const minimize = useCallback(() => {
    dispatch({ type: "minimize" });
    haptics.tap();
  }, []);

  const expand = useCallback(() => {
    dispatch({ type: "expand" });
    haptics.tap();
  }, []);

  const declineIncoming = useCallback(() => {
    for (const timer of incomingTimers.current) clearTimeout(timer);
    incomingTimers.current = [];
    const ringer = incomingRinger.current;
    incomingRinger.current = undefined;
    if (ringer) {
      try { ringer.pause(); } catch { /* gone */ }
      try { ringer.remove(); } catch { /* gone */ }
    }
    setIncoming(undefined);
  }, []);

  const offerIncoming = useCallback((turn: IncomingCall) => {
    // A call already running wins: the assistant says what finished instead.
    if (call.current) return;
    if (!shouldRingForTurn(turn, { onScreen: opts.current.onSessionShown, callActive: false })) return;
    declineIncoming();
    haptics.attention();
    try {
      const ringer = createAudioPlayer(RINGTONE);
      ringer.loop = true;
      ringer.play();
      incomingRinger.current = ringer;
    } catch {
      // No sound module in this build: the banner alone carries the offer.
    }
    incomingTimers.current.push(setTimeout(() => {
      const ringer = incomingRinger.current;
      incomingRinger.current = undefined;
      if (ringer) {
        try { ringer.pause(); } catch { /* gone */ }
        try { ringer.remove(); } catch { /* gone */ }
      }
    }, RING_MS));
    incomingTimers.current.push(setTimeout(() => setIncoming(undefined), INCOMING_EXPIRE_MS));
    setIncoming(turn);
  }, [declineIncoming]);

  const acceptIncoming = useCallback(() => {
    const turn = incoming;
    declineIncoming();
    if (turn) start(turn.sessionId);
  }, [incoming, declineIncoming, start]);

  const providerName = options.providerName;
  return useMemo(() => ({
    offered: options.voice !== undefined,
    state,
    open: state.phase !== "idle" && !state.minimized,
    active: state.phase !== "idle",
    minimized: state.minimized,
    incoming,
    usageLine: voiceUsageLine(state, now),
    orb: voiceOrb(state, now),
    statusLine: voiceStatusLine(state, providerName),
    start,
    end,
    toggleMute,
    minimize,
    expand,
    offerIncoming,
    acceptIncoming,
    declineIncoming,
    dismiss,
  }), [options.voice, state, now, incoming, providerName, start, end, toggleMute, minimize, expand, offerIncoming, acceptIncoming, declineIncoming, dismiss]);
}

/** Stop and release a call's ringtone. Safe to call twice. */
function stopRinger(target: Call) {
  const ringer = target.ringer;
  if (!ringer) return;
  target.ringer = undefined;
  try { ringer.pause(); } catch { /* already gone */ }
  try { ringer.remove(); } catch { /* already gone */ }
}

/** Resolve once ICE gathering completes, or after `timeoutMs` with what was gathered. */
function iceGathered(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function check() {
      if (pc.iceGatheringState === "complete") done();
    }
    function done() {
      clearTimeout(timer);
      pc.onicegatheringstatechange = null;
      resolve();
    }
    pc.onicegatheringstatechange = check;
  });
}
