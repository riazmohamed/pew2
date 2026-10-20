/**
 * Pew ringing an Android phone like a call (`android/.../PewRinger.kt`): the
 * ring arrives as a data-only push and plays the phone's own ringtone on
 * repeat, with Answer and Decline, even with the app closed and the phone
 * locked. A notification could only ever play a short alert sound.
 *
 * Optional, like `pew-call`: without the native module (iOS, an older build)
 * every function is a harmless no-op and `nativeRinger` is false, so the app
 * never tells the daemon to send rings this way.
 */
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

interface PewRingNative {
  claim(ringId: string): boolean;
  claimed(ringId: string): boolean;
  stop(): void;
  takeEnded(): { ring: string; reason: string }[];
}

const native = Platform.OS === "android" ? requireOptionalNativeModule<PewRingNative>("PewRing") : null;

/** This build rings natively on Android (the daemon may send rings as data-only pushes). */
export const nativeRinger = native !== null;

/** Take a ring for the app's own card. True when nothing else has rung it. */
export function claimRing(ringId: string): boolean {
  try {
    return native ? native.claim(ringId) : true;
  } catch {
    return true;
  }
}

/** Whether the native ring already took this one. */
export function ringClaimed(ringId: string): boolean {
  try {
    return native ? native.claimed(ringId) : false;
  } catch {
    return false;
  }
}

/** Stop a native ring (answered, or a call started another way). */
export function stopNativeRing(): void {
  try {
    native?.stop();
  } catch {
    // Nothing ringing.
  }
}

/** Declines and misses the native ring saw, since last asked. */
export function takeEndedRings(): { ringId: string; reason: "declined" | "missed" }[] {
  try {
    return (native?.takeEnded() ?? [])
      .filter((item) => item.ring && (item.reason === "declined" || item.reason === "missed"))
      .map((item) => ({ ringId: item.ring, reason: item.reason as "declined" | "missed" }));
  } catch {
    return [];
  }
}

/** The ring a `pew2://ring/answer?ring=…&focus=…` link answers, if it is one. */
export function answeredRing(url: string): { ringId: string; focus?: string } | undefined {
  const match = /^pew2:\/\/ring\/answer\?(.*)$/.exec(url);
  if (!match) return undefined;
  const params = new Map<string, string>();
  for (const part of (match[1] ?? "").split("&")) {
    const [key, value = ""] = part.split("=");
    if (!key) continue;
    try {
      params.set(key, decodeURIComponent(value.replace(/\+/g, " ")));
    } catch {
      params.set(key, value);
    }
  }
  const ringId = params.get("ring");
  if (!ringId) return undefined;
  const focus = params.get("focus");
  return { ringId, ...(focus ? { focus } : {}) };
}
