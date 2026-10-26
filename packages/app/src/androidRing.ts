/**
 * Pew ringing a phone the system cannot ring (Android): the decisions, pure,
 * so `bun test` runs them. The effects are `ui/useAndroidRing.ts`'s.
 *
 * The daemon decides when to ring, the same as for an iPhone (`voiceRing.ts`
 * has the gates), and sends `voice.ring` over the socket beside the call push.
 * An iPhone CallKit rings ignores the frame, so it never rings twice.
 */
import type { wire } from "@pew2/protocol";

/** How long the phone rings before the ring counts as missed (CallKit's own is about this). */
export const RING_MS = 30_000;

export interface IncomingRing {
  ringId: string;
  title: string;
  caller: string;
  body: string;
  focus?: string;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** A `voice.ring` frame, or undefined for anything else or a malformed one. */
export function readRing(message: unknown): IncomingRing | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const frame = message as Record<string, unknown>;
  if (frame.t !== "voice.ring") return undefined;
  const ringId = str(frame.ringId);
  const body = str(frame.body);
  if (!ringId || !body) return undefined;
  const focus = str(frame.focus);
  return {
    ringId,
    title: str(frame.title) ?? "pew2 needs you",
    caller: str(frame.caller) ?? "Pew",
    body,
    ...(focus ? { focus } : {}),
  };
}

/**
 * What a ring does here.
 *
 * - `ignore`: the system rings this phone (CallKit), or a call is already on.
 * - `banner`: no consent to calls yet. A banner only, as an iPhone gets: its
 *   tap opens the call flow, which asks first.
 * - `ring`: tone, card and (in the background) a banner.
 */
export function ringAction(options: {
  systemRings: boolean;
  consented: boolean;
  callActive: boolean;
}): "ignore" | "banner" | "ring" {
  if (options.systemRings || options.callActive) return "ignore";
  return options.consented ? "ring" : "banner";
}

/** The daemon's record of a ring nobody answered (it holds the next one off). */
export function ringEnded(ring: IncomingRing, reason: "declined" | "missed"): wire.VoiceEnd {
  return { t: "voice.end", callId: ring.ringId, reason };
}
