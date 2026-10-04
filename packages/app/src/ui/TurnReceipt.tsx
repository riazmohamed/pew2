/**
 * What the finished turn cost, in one quiet line under the answer.
 *
 * The live activity line exits when the turn ends, which would otherwise leave
 * no trace of work that took minutes. This is that trace: a receipt, not a
 * status. Faint, static, and it never competes with the reply above it.
 *
 * Everything in it is measured or reported — the duration by this device, the
 * tool count by the agent, tokens only when the agent volunteered a figure.
 * It is replaced by the activity line again the moment the next prompt is sent.
 */
import { memo, useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text } from "react-native";
import { theme } from "../theme";
import { receiptText, type TurnReceipt as Receipt } from "../activity";
import { useReducedMotion } from "./useReducedMotion";
import { STATUS_ROW_MAX_FONT_SCALE } from "./statusRow";
import { useStatusRowHeight } from "./useStatusRowHeight";

/** Slower than a control's transition: this arrives, it does not respond. */
const FADE_DURATION = 260;

function TurnReceiptView({
  receipt,
  onPress,
}: {
  receipt: Receipt;
  /** Opens the turn's tools: each one's title, and its diff or output. */
  onPress: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const height = useStatusRowHeight();
  const fade = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reduceMotion) {
      fade.setValue(1);
      return;
    }
    fade.setValue(0);
    Animated.timing(fade, {
      toValue: 1,
      duration: FADE_DURATION,
      easing: theme.easing,
      useNativeDriver: true,
    }).start();
  }, [fade, reduceMotion, receipt]);

  const text = receiptText(receipt);

  return (
    <Pressable
      onPress={onPress}
      // A plain answer has nothing to open; the tap only exists with tools.
      disabled={receipt.runs.length === 0}
      accessibilityRole={receipt.runs.length > 0 ? "button" : undefined}
      accessibilityHint={receipt.runs.length > 0 ? "Shows what each tool did" : undefined}
    >
    <Animated.View
      style={[styles.row, { height, opacity: fade }]}
      accessible
      accessibilityLabel={text}
    >
      {/* The mark that says this row is the app talking, not the agent. */}
      <Text style={styles.mark} maxFontSizeMultiplier={STATUS_ROW_MAX_FONT_SCALE}>
        ✻
      </Text>
      {/* Capped where the row stops growing, so large text lengthens the line
          rather than clipping inside it. */}
      <Text style={styles.text} numberOfLines={1} maxFontSizeMultiplier={STATUS_ROW_MAX_FONT_SCALE}>
        {text}
      </Text>
    </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Same left rail and rhythm as the activity line it replaces.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1.5),
    marginTop: theme.space(5),
    paddingHorizontal: theme.gutter,
  },
  mark: {
    fontSize: theme.font.small,
    lineHeight: theme.line.body,
    color: theme.color.accent,
  },
  text: {
    flexShrink: 1,
    fontSize: theme.font.small,
    lineHeight: theme.line.body,
    color: theme.color.textFaint,
  },
});

export const TurnReceipt = memo(TurnReceiptView);
