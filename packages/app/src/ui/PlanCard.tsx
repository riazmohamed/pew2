/**
 * The agent's plan and its newest steps, above the composer.
 *
 * Collapsed it is one line — "Step 3/5 · what it is doing" — and a tap opens the list
 * with a tick per entry. It sits inside the dock so the transcript's inset
 * follows its height like everything else there, and it disappears the moment
 * the plan is finished: a done list is the receipt's job to summarise.
 */
import { memo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import type { PlanEntry } from "../chunks";
import type { ToolStatus } from "../activity";
import type { WorkProgress } from "../workProgress";
import { touchSlop } from "./controls";

const STATUS: Record<PlanEntry["status"], { icon: keyof typeof Ionicons.glyphMap; color: string }> =
  {
    pending: { icon: "ellipse-outline", color: theme.color.textFaint },
    in_progress: { icon: "play-circle-outline", color: theme.color.accent },
    completed: { icon: "checkmark-circle", color: theme.color.success },
    cancelled: { icon: "remove-circle-outline", color: theme.color.textFaint },
  };

const STEP: Record<ToolStatus, { icon: keyof typeof Ionicons.glyphMap; color: string }> = {
  pending: { icon: "ellipse-outline", color: theme.color.textFaint },
  in_progress: { icon: "play-circle-outline", color: theme.color.accent },
  completed: { icon: "checkmark-circle", color: theme.color.success },
  failed: { icon: "close-circle", color: theme.color.danger },
};

/**
 * The work in progress: the plan with its ticks and the newest tool steps,
 * streaming as the agent goes. Open by default so the plan and steps are in
 * view without a tap (28 Oct: "we should be able to see the plan and steps
 * streaming"); a tap folds it to one line.
 */
function PlanCardView({ work }: { work: WorkProgress }) {
  const [open, setOpen] = useState(true);
  return (
    <View style={styles.card}>
      <Pressable
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
        hitSlop={touchSlop(theme.space(1))}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={work.now ? `${work.spoken}. Now: ${work.now}` : work.spoken}
        onPress={() => setOpen((value) => !value)}
      >
        <Ionicons name="list-outline" size={14} color={theme.color.textDim} />
        <Text style={styles.summary} numberOfLines={1}>
          {work.summary}
          {work.now && !open ? <Text style={styles.current}> · {work.now}</Text> : null}
        </Text>
        <Ionicons
          name={open ? "chevron-down" : "chevron-up"}
          size={12}
          color={theme.color.textDim}
        />
      </Pressable>
      {open ? (
        <ScrollView style={styles.body} nestedScrollEnabled>
          {work.plan.map((entry, index) => (
            <View
              key={`p${index}`}
              style={styles.entry}
              accessible
              accessibilityLabel={`${entry.status.replace("_", " ")}: ${entry.content}`}
            >
              <Ionicons
                name={STATUS[entry.status].icon}
                size={14}
                color={STATUS[entry.status].color}
              />
              <Text
                style={[
                  styles.entryText,
                  entry.status === "in_progress" && styles.nowText,
                  entry.status === "completed" && styles.doneText,
                  entry.status === "cancelled" && styles.cancelledText,
                ]}
              >
                <Text style={styles.entryNumber}>{index + 1}. </Text>
                {entry.content}
              </Text>
            </View>
          ))}
          {work.steps.length > 0 ? (
            <View style={work.plan.length > 0 ? styles.stepsAfterPlan : undefined}>
              {work.earlier > 0 ? (
                <Text style={styles.earlier}>
                  {work.earlier} earlier step{work.earlier === 1 ? "" : "s"}
                </Text>
              ) : null}
              {work.steps.map((step) => (
                <View
                  key={step.id}
                  style={styles.entry}
                  accessible
                  accessibilityLabel={`${step.status.replace("_", " ")}: ${step.title}`}
                >
                  <Ionicons
                    name={STEP[step.status].icon}
                    size={13}
                    color={STEP[step.status].color}
                  />
                  <Text
                    style={[styles.stepText, step.status === "completed" && styles.stepDone]}
                    numberOfLines={2}
                  >
                    {step.title}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </ScrollView>
      ) : null}
    </View>
  );
}

/**
 * A plan is waiting for the user's decision but its sheet was set aside
 * ("Decide later", or Android back): one tap brings the Accept / Feedback /
 * Reject sheet back, so a plan never waits with no way to answer it.
 */
export function PlanWaitingPill({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.card, styles.waiting, pressed && styles.pressed]}
      hitSlop={touchSlop(theme.space(1))}
      accessibilityRole="button"
      accessibilityLabel="A plan is waiting for you. Review it"
      onPress={onPress}
    >
      <Ionicons name="document-text-outline" size={14} color={theme.color.accent} />
      <Text style={styles.waitingText} numberOfLines={1}>
        Plan waiting for you
      </Text>
      <Text style={styles.waitingAction}>Review</Text>
    </Pressable>
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
  nowText: { color: theme.color.accent, fontWeight: "600" },
  entryNumber: { color: theme.color.textFaint, fontWeight: "400" },
  doneText: { color: theme.color.textDim, textDecorationLine: "line-through" },
  body: { maxHeight: 220 },
  waiting: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
  },
  waitingText: { flex: 1, color: theme.color.text, fontSize: theme.font.small, fontWeight: "600" },
  waitingAction: { color: theme.color.accent, fontSize: theme.font.small, fontWeight: "700" },
  stepsAfterPlan: {
    marginTop: theme.space(1),
    paddingTop: theme.space(1),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.border,
  },
  earlier: {
    color: theme.color.textFaint,
    fontSize: theme.font.small,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(0.5),
  },
  stepText: { flex: 1, color: theme.color.textDim, fontSize: theme.font.small, lineHeight: 17 },
  stepDone: { color: theme.color.textFaint },
  cancelledText: { color: theme.color.textFaint, textDecorationLine: "line-through" },
});

export const PlanCard = memo(PlanCardView);
