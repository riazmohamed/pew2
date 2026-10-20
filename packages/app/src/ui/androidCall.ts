/**
 * A Pew call's Android half: the audio route and the locked-screen mic.
 *
 * iOS gets both from the system (`UIBackgroundModes: audio`, CallKit, and the
 * `pew-audio-route` module). Android has neither, so:
 *
 * - **Route.** InCallManager runs the call as a phone call: the earpiece, the
 *   proximity sensor turning the screen off at the ear, and a Bluetooth
 *   headset when one is connected (Android 12+ needs the runtime
 *   `BLUETOOTH_CONNECT` grant for that; refusing it only means no headset).
 *   The call screen's speaker button switches to the loudspeaker and back.
 * - **Locked screen.** Android cuts the microphone of an app that is not in
 *   front unless a microphone foreground service runs, and only lets that
 *   start while the app is in front with the mic granted. So it starts when
 *   the call goes live (the transport has the mic by then), and stops with
 *   the call (`modules/voice-call-service`).
 *
 * Every function is a no-op off Android, and never throws: a call goes ahead
 * without whatever part failed.
 */
import { PermissionsAndroid, Platform } from "react-native";
import InCallManager from "react-native-incall-manager";
import { startVoiceCallService, stopVoiceCallService } from "../../modules/voice-call-service";

const android = Platform.OS === "android";

let routed = false;
let speakerOn = false;

/** The call is starting: ask for Bluetooth once, then route it as a phone call. */
export function beginAndroidCall(): void {
  if (!android || routed) return;
  routed = true;
  speakerOn = false;
  void (async () => {
    if (Number(Platform.Version) >= 31) {
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT).catch(() => undefined);
    }
    // Ended while the permission was being asked: nothing to route.
    if (!routed) return;
    try {
      InCallManager.start({ media: "audio", auto: true });
      // No screen-off at the ear. `start` turns on the proximity sensor, and
      // the screen going off and on under Pew's animated canvas is where the
      // app crashed mid-call (Skia SIGSEGV, 20 Oct, twice). A phone in a car
      // mount wants the screen on anyway.
      InCallManager.stopProximitySensor();
    } catch {
      // No routing module: WebRTC's own default route plays the call.
    }
  })();
}

/** The call is live, so the mic is granted: keep it with the screen locked. */
export function androidCallLive(): void {
  if (!android) return;
  startVoiceCallService("Call with Pew", "Pew is on the line. Tap to return.");
}

/** The call is over: give the audio back and stop the service. Safe twice. */
export function endAndroidCall(): void {
  if (!android) return;
  stopVoiceCallService();
  if (!routed) return;
  routed = false;
  speakerOn = false;
  try {
    InCallManager.setForceSpeakerphoneOn(false);
    InCallManager.stop();
  } catch {
    // Never started.
  }
}

/** Whether this build switches the speaker here (Android: always, via InCallManager). */
export const androidSpeakerSwitch = android;

/** Loudspeaker on or off. True when it switched. */
export function setAndroidSpeaker(on: boolean): boolean {
  if (!android || !routed) return false;
  try {
    InCallManager.setForceSpeakerphoneOn(on);
    speakerOn = on;
    return true;
  } catch {
    return false;
  }
}

export function androidSpeakerOn(): boolean {
  return speakerOn;
}
