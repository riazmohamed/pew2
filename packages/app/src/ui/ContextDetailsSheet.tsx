import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Sheet, useSheetCardHeight } from "./Sheet";
import { theme } from "../theme";
import { contextDetails } from "../contextDetails";
import type { ContextUsage } from "../contextUsage";
import type { Workspace } from "../useDaemon";

export function ContextDetailsSheet({ visible, workspace, usage, onClose }: { visible: boolean; workspace?: Workspace; usage?: ContextUsage; onClose: () => void }) {
  const details = contextDetails(workspace, usage);
  const cardHeight = useSheetCardHeight();
  return <Sheet visible={visible} title="Project details" onClose={onClose} dismissLabel="Close project details">
    <ScrollView style={{ maxHeight: cardHeight }} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={styles.label}>Project</Text>
        <Text selectable style={styles.value}>{details.project}</Text>
        {workspace?.cwd && <Text selectable style={styles.label}>{workspace.cwd}</Text>}
      </View>
      <View style={styles.section}>
        <Text style={styles.label}>Context usage</Text>
        <Text style={[styles.value, details.warning && { color: details.level === "critical" ? theme.color.danger : theme.color.accent }]} accessibilityLabel={details.usageAccessibility}>{details.usage}</Text>
        {details.warning && <Text style={styles.label}>{details.level === "critical" ? "Context is nearly full. Compaction is close." : "Context usage is high."}</Text>}
      </View>
      <View style={styles.section}>
        <Text style={styles.label}>Git status</Text>
        <Text style={styles.value} accessibilityLabel={details.changesAccessibility}>{details.changes}</Text>
      </View>
    </ScrollView>
  </Sheet>;
}
const styles = StyleSheet.create({
  content: { paddingHorizontal: theme.gutter, paddingVertical: theme.sectionGap, gap: theme.sectionGap },
  section: { gap: theme.space(2) },
  label: { color: theme.color.textDim, fontSize: theme.font.small, lineHeight: 18 },
  value: { color: theme.color.text, fontSize: theme.font.body, lineHeight: theme.line.body },
});
