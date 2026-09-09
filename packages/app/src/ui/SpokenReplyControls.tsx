import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import type { ReadAloudControls } from "./useReadAloud";

export const SpokenReplyControls = memo(function SpokenReplyControls({ voice }: { voice: ReadAloudControls }) {
  return (
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
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
  button: { minHeight: 44, justifyContent: "center", paddingHorizontal: theme.space(2), borderRadius: theme.space(2) },
  pressed: { backgroundColor: theme.color.surfacePressed },
  text: { color: theme.color.textDim, fontSize: 13 },
  disabled: { color: theme.color.textFaint },
});
