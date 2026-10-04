/**
 * The agent's plan, above the composer.
 *
 * Collapsed it is one line — "Plan · 2 of 5 done" — and a tap opens the list
 * with a tick per entry. It sits inside the dock so the transcript's inset
 * follows its height like everything else there, and it disappears the moment
 * the plan is finished: a done list is the receipt's job to summarise.
 */
import { memo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import type { PlanEntry } from "../chunks";
import { touchSlop } from "./controls";

const STATUS: Record<PlanEntry["status"], { icon: keyof typeof Ionicons.glyphMap; color: string }> = {
  pending: { icon: "ellipse-outline", color: theme.color.textFaint },
  in_progress: { icon: "play-circle-outline", color: theme.color.accent },
  completed: { icon: "checkmark-circle", color: theme.color.success },
  cancelled: { icon: "remove-circle-outline", color: theme.color.textFaint },
};

function PlanCardView({ plan }: { plan: readonly PlanEntry[] }) {
  const [open, setOpen] = useState(false);
  const live = plan.filter((entry) => entry.status !== "cancelled");
  const done = live.filter((entry) => entry.status === "completed").length;
  if (live.length === 0 || done === live.length) return null;

  const current = live.find((entry) => entry.status === "in_progress");
  const summary = `Plan · ${done} of ${live.length} done`;

  return (
    <View style={styles.card}>
      <Pressable
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
        hitSlop={touchSlop(theme.space(1))}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={current ? `${summary}. Now: ${current.content}` : summary}
        onPress={() => setOpen((value) => !value)}
      >
        <Ionicons name="list-outline" size={14} color={theme.color.textDim} />
        <Text style={styles.summary} numberOfLines={1}>
          {summary}
          {current && !open ? (
            <Text style={styles.current}> · {current.content}</Text>
          ) : null}
        </Text>
        <Ionicons
          name={open ? "chevron-down" : "chevron-up"}
          size={12}
          color={theme.color.textDim}
        />
      </Pressable>
      {open &&
        plan.map((entry, index) => (
          <View key={index} style={styles.entry} accessible accessibilityLabel={`${entry.status.replace("_", " ")}: ${entry.content}`}>
            <Ionicons name={STATUS[entry.status].icon} size={14} color={STATUS[entry.status].color} />
            <Text
              style={[
                styles.entryText,
                entry.status === "completed" && styles.doneText,
                entry.status === "cancelled" && styles.cancelledText,
              ]}
            >
              {entry.content}
            </Text>
          </View>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: theme.space(3),
    marginBottom: theme.space(1),
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    paddingVertical: theme.space(1),
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingHorizontal: theme.space(3),
    minHeight: 32,
  },
  pressed: { opacity: 0.6 },
  summary: {
    flex: 1,
    minWidth: 0,
    color: theme.color.text,
    fontSize: theme.font.small,
    fontWeight: "600",
  },
  current: { color: theme.color.textDim, fontWeight: "400" },
  entry: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.space(2),
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(1),
  },
  entryText: {
    flex: 1,
    color: theme.color.text,
    fontSize: theme.font.small,
    lineHeight: 18,
  },
  doneText: { color: theme.color.textDim, textDecorationLine: "line-through" },
  cancelledText: { color: theme.color.textFaint, textDecorationLine: "line-through" },
});

export const PlanCard = memo(PlanCardView);
