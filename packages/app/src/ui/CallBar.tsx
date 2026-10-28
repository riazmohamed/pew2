/**
 * The call with Pew, put away to a banner over the chat (modelled on the old
 * VoiceBar). The call carries on in `useVoice`; this only shows it: a small
 * Pew, one status line (and the busiest project's current step), mute, end,
 * and a tap on the body to bring the call screen back. The project name opens
 * that chat.
 *
 * Sits just below the top bar, so it never covers the menu or the composer.
 */
import { memo, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme } from "../theme";
import { Pew } from "../pew/Pew";
import { DotGlyph } from "./stage/DotGlyph";
import { useCalmMotion } from "./calmMotion";
import { haptics } from "./haptics";
import { callBarLine } from "../callMinimise";
import type { CallState } from "../voiceCall";
import { boardView, type BoardState } from "../voiceBoard";

interface Props {
  call: CallState;
  board: BoardState;
  reconnecting: boolean;
  /** Distance from the screen's top: under the top bar. */
  top: number;
  color?: string;
  onExpand: () => void;
  onMute: (muted: boolean) => void;
  onHangUp: () => void;
  /** Open the busiest lane's chat. Absent: the project name is plain text. */
  onOpenSession?: (sessionId: string) => void;
}

function CallBarView({
  call,
  board,
  reconnecting,
  top,
  color,
  onExpand,
  onMute,
  onHangUp,
  onOpenSession,
}: Props) {
  const insets = useSafeAreaInsets();
  const calm = useCalmMotion();
  // A slow clock: the lane's current step is held and swapped on time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const line = callBarLine(call, reconnecting, boardView(board, call, now).lanes);
  const live = call.phase === "live";
  const mood = call.pewAudio ? "talking" : call.phase === "connecting" ? "working" : "idle";
  const lane = line.lane;
  return (
    <View
      style={[
        styles.wrap,
        { top, left: insets.left + theme.gutter, right: insets.right + theme.gutter },
      ]}
      pointerEvents="box-none"
    >
      <View style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Return to the call"
          onPress={() => {
            haptics.select();
            onExpand();
          }}
          style={({ pressed }) => [styles.body, pressed && styles.pressed]}
        >
          <Pew size={28} mood={mood} color={color} paused={calm} />
          <View style={styles.text}>
            <Text
              numberOfLines={1}
              style={[styles.status, reconnecting && styles.attention]}
              accessibilityLiveRegion="polite"
            >
              {line.status}
            </Text>
            {lane ? (
              <Text numberOfLines={1} style={styles.step}>
                <Text
                  style={styles.project}
                  onPress={onOpenSession ? () => onOpenSession(lane.sessionId) : undefined}
                  accessibilityRole={onOpenSession ? "link" : undefined}
                >
                  {lane.folder}
                </Text>
                {lane.step ? ` · ${lane.step}` : ""}
              </Text>
            ) : null}
          </View>
          <DotGlyph name="up" size={12} color={theme.color.textDim} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={call.muted ? "Unmute" : "Mute"}
          accessibilityState={{ selected: call.muted, disabled: !live }}
          disabled={!live}
          onPress={() => onMute(!call.muted)}
          style={({ pressed }) => [
            styles.button,
            pressed && styles.pressed,
            !live && styles.dimmed,
          ]}
        >
          <DotGlyph
            name={call.muted ? "mic-off" : "mic"}
            size={18}
            color={call.muted ? theme.color.danger : undefined}
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="End call"
          onPress={() => {
            haptics.warned(null);
            onHangUp();
          }}
          style={({ pressed }) => [styles.button, styles.hangUp, pressed && styles.pressed]}
        >
          <DotGlyph name="close" size={16} color={theme.color.text} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", zIndex: 6, alignItems: "center" },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    maxWidth: 520,
    gap: theme.space(1),
    paddingLeft: theme.space(2),
    paddingRight: theme.space(1),
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    // Solid: it floats over a scrolling chat.
    backgroundColor: theme.color.surfaceRaised,
  },
  body: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    minWidth: 0,
    paddingVertical: theme.space(1.5),
  },
  text: { flex: 1, minWidth: 0 },
  status: { color: theme.color.text, fontSize: theme.font.body },
  attention: { color: theme.color.attention },
  step: { color: theme.color.textDim, fontSize: theme.font.small },
  project: { color: theme.color.text, textDecorationLine: "underline" },
  button: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  hangUp: { backgroundColor: theme.color.danger },
  pressed: { opacity: 0.65 },
  dimmed: { opacity: 0.4 },
});

export const CallBar = memo(CallBarView);
