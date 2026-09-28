import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import type { ReadAloudControls } from "./useReadAloud";
import type { HandsFreeControls } from "./useHandsFree";

const labels = {
  off: "Foreground only. Takes turns listening and speaking.",
  starting: "Starting microphone…",
  listening: "Listening",
  "pending-send": "Sending soon · 3-second cancellation window",
  finalising: "Finishing dictation…",
  waiting: "Waiting for reply · microphone off",
  speaking: "Speaking · microphone off",
  paused: "Paused",
};

export const SpokenReplyControls = memo(function SpokenReplyControls({ voice, handsFree, hasDraft = false }: { voice: ReadAloudControls; handsFree?: HandsFreeControls; hasDraft?: boolean }) {
  // Draft emptiness is local to the dock. Re-evaluate eligibility here rather
  // than retaining a disabled switch until the root happens to render again.
  const unavailable = hasDraft && (handsFree?.state === "off" || handsFree?.state === "paused")
    ? "Send or clear your draft first." : handsFree?.unavailable();
  return (
    <View>
    <View style={styles.row}>
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel="Spoken replies"
        accessibilityState={{ checked: voice.enabled, disabled: !voice.available }}
        disabled={!voice.available}
        onPress={voice.toggle}
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      >
        <Text style={styles.text}>
          {!voice.available ? "Speech needs a native rebuild" : `Spoken replies: ${voice.enabled ? "on" : "off"}`}
        </Text>
      </Pressable>
      {voice.enabled && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={voice.speaking ? "Stop speaking" : "Replay last reply"}
          accessibilityState={{ disabled: !voice.speaking && !voice.canReplay }}
          disabled={!voice.speaking && !voice.canReplay}
          onPress={voice.speaking ? voice.stop : voice.replay}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          <Text style={[styles.text, !voice.speaking && !voice.canReplay && styles.disabled]}>
            {voice.speaking ? "Stop speaking" : "Replay reply"}
          </Text>
        </Pressable>
      )}
    </View>
    {handsFree && <>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel="Hands-free"
          accessibilityHint={unavailable ?? "Automatically send after a pause, hear the reply, then listen again. Keep the app open."}
          accessibilityState={{ checked: handsFree.enabled, disabled: !handsFree.enabled && !!unavailable }}
          disabled={!handsFree.enabled && !!unavailable}
          onPress={handsFree.toggle}
          style={({ pressed }) => [styles.button, styles.switch, pressed && styles.pressed]}
        >
          <Text style={[styles.text, !handsFree.enabled && !!unavailable && styles.disabled]}>
            {`Hands-free: ${handsFree.enabled ? "on" : "off"}`}
          </Text>
        </Pressable>
        {handsFree.enabled && <Pressable
          accessibilityRole="button"
          accessibilityLabel={handsFree.state === "paused" ? "Resume hands-free" : "Pause hands-free and cancel automatic send"}
          accessibilityState={{ disabled: handsFree.state === "paused" && !!unavailable }}
          disabled={handsFree.state === "paused" && !!unavailable}
          onPress={handsFree.state === "paused" ? handsFree.resume : handsFree.pause}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          <Text style={styles.text}>{handsFree.state === "paused" ? "Resume" :
            handsFree.state === "pending-send" || handsFree.state === "finalising" ? "Cancel send" : "Pause"}</Text>
        </Pressable>}
      </View>
      <Text accessibilityLiveRegion="polite" style={[styles.text, styles.status]}>
        {handsFree.state === "off" ? unavailable || labels.off : handsFree.reason || unavailable || labels[handsFree.state]}
      </Text>
    </>}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
  button: { minHeight: 44, justifyContent: "center", paddingHorizontal: theme.space(2), borderRadius: theme.space(2) },
  pressed: { backgroundColor: theme.color.surfacePressed },
  switch: { borderWidth: 1, borderColor: theme.color.textFaint },
  status: { paddingHorizontal: theme.space(2), paddingBottom: theme.space(1) },
  text: { color: theme.color.textDim, fontSize: 13 },
  disabled: { color: theme.color.textFaint },
});
