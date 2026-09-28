import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import type { ReadAloudControls } from "./useReadAloud";
import type { HandsFreeControls } from "./useHandsFree";

const labels = {
  starting: "Starting microphone…",
  listening: "Listening",
  "pending-send": "Sending soon · 3-second cancellation window",
  finalising: "Finishing dictation…",
  waiting: "Waiting for reply · microphone off",
  speaking: "Speaking · microphone off",
  paused: "Paused",
};

/**
 * One row of text buttons, styled like the context row above it.
 *
 * The status line is not permanent: while hands-free is off it appears only
 * after a tap it had to refuse, and only while the reason still holds. A
 * standing "Open a live conversation first." on every screen was a third row
 * of chrome over the transcript that said nothing the user had asked about.
 * Screen readers still get the reason up front, as the switch's hint.
 */
export const SpokenReplyControls = memo(function SpokenReplyControls({ voice, handsFree, hasDraft = false }: { voice: ReadAloudControls; handsFree?: HandsFreeControls; hasDraft?: boolean }) {
  // Draft emptiness is local to the dock. Re-evaluate eligibility here rather
  // than retaining a stale reason until the root happens to render again.
  const unavailable = hasDraft && (handsFree?.state === "off" || handsFree?.state === "paused")
    ? "Send or clear your draft first." : handsFree?.unavailable();
  const status = !handsFree ? undefined
    : handsFree.state === "off" ? (handsFree.reason ? unavailable : undefined)
    : handsFree.reason || unavailable || labels[handsFree.state];
  return (
    <View style={styles.block}>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel="Spoken replies"
          accessibilityState={{ checked: voice.enabled, disabled: !voice.available }}
          disabled={!voice.available}
          onPress={voice.toggle}
          style={({ pressed }) => [styles.item, pressed && styles.pressed]}
        >
          <Text style={[styles.label, voice.enabled && styles.on, !voice.available && styles.disabled]}>
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
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}
          >
            <Text style={[styles.label, !voice.speaking && !voice.canReplay && styles.disabled]}>
              {voice.speaking ? "Stop" : "Replay"}
            </Text>
          </Pressable>
        )}
        {handsFree && (
          // Not `disabled` when unavailable: a tap is how the user asks why,
          // and the controller answers by setting the reason shown below.
          <Pressable
            accessibilityRole="switch"
            accessibilityLabel="Hands-free"
            accessibilityHint={unavailable ?? "Automatically send after a pause, hear the reply, then listen again. Keep the app open."}
            accessibilityState={{ checked: handsFree.enabled }}
            onPress={handsFree.toggle}
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}
          >
            <Text style={[styles.label, handsFree.enabled && styles.on, !handsFree.enabled && !!unavailable && styles.disabled]}>
              {`Hands-free: ${handsFree.enabled ? "on" : "off"}`}
            </Text>
          </Pressable>
        )}
        {handsFree?.enabled && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={handsFree.state === "paused" ? "Resume hands-free" : "Pause hands-free and cancel automatic send"}
            accessibilityState={{ disabled: handsFree.state === "paused" && !!unavailable }}
            disabled={handsFree.state === "paused" && !!unavailable}
            onPress={handsFree.state === "paused" ? handsFree.resume : handsFree.pause}
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}
          >
            <Text style={styles.label}>{handsFree.state === "paused" ? "Resume" :
              handsFree.state === "pending-send" || handsFree.state === "finalising" ? "Cancel send" : "Pause"}</Text>
          </Pressable>
        )}
      </View>
      {status ? (
        <Text accessibilityLiveRegion="polite" style={[styles.label, styles.status]}>{status}</Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  block: { marginBottom: theme.space(2) },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(5) },
  item: { minHeight: theme.size.touch, minWidth: theme.size.touch, justifyContent: "center" },
  pressed: { opacity: 0.6 },
  label: { color: theme.color.textDim, fontSize: theme.font.small, lineHeight: 17, fontWeight: "600" },
  on: { color: theme.color.text },
  status: { fontWeight: "400", paddingBottom: theme.space(1) },
  disabled: { color: theme.color.textFaint },
});
