/**
 * What the agent's tools actually did, opened from the activity line or the
 * turn's receipt.
 *
 * The line under the transcript says "Edited & ran · 4 tools"; this is the
 * four tools. First a list, then one tool's output: an edit as the diff of the
 * file, a command as what it printed, anything else as the text it returned.
 * Nothing is fetched — every byte was already in the `tool_call` events the
 * activity fold kept (`activity.ts`).
 */
import { memo, useEffect, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import type { ToolContent, ToolKind, ToolRun, ToolStatus } from "../activity";
import { hunks, lineDiff } from "../lineDiff";
import { SHEET_ROW_HEIGHT, Sheet, sheetCardStyle, useSheetMaxContentHeight } from "./Sheet";

const monospace = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

const ICONS: Record<ToolKind, keyof typeof Ionicons.glyphMap> = {
  read: "document-text-outline",
  edit: "create-outline",
  delete: "trash-outline",
  move: "arrow-forward-outline",
  search: "search-outline",
  execute: "terminal-outline",
  think: "bulb-outline",
  fetch: "cloud-download-outline",
  other: "ellipsis-horizontal",
};

const STATUS: Record<ToolStatus, { icon: keyof typeof Ionicons.glyphMap; color: string }> = {
  pending: { icon: "ellipse-outline", color: theme.color.textFaint },
  in_progress: { icon: "sync-outline", color: theme.color.accent },
  completed: { icon: "checkmark-circle", color: theme.color.success },
  failed: { icon: "close-circle", color: theme.color.danger },
};

interface ToolSheetProps {
  visible: boolean;
  tools: readonly ToolRun[];
  onClose: () => void;
}

function ToolSheetView({ visible, tools, onClose }: ToolSheetProps) {
  const maxHeight = useSheetMaxContentHeight();
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const open = tools.find((tool) => tool.id === openId);

  useEffect(() => {
    if (!visible) setOpenId(undefined);
  }, [visible]);

  return (
    <Sheet
      visible={visible}
      title={open ? open.title || "Tool" : "What it did"}
      onClose={onClose}
      onBack={open ? () => setOpenId(undefined) : undefined}
      dismissLabel="Close tools"
    >
      <View style={styles.card}>
        <ScrollView style={{ maxHeight }}>
          {open ? (
            <ToolDetail tool={open} />
          ) : (
            tools.map((tool, index) => (
              <Pressable
                key={tool.id}
                style={({ pressed }) => [
                  styles.row,
                  index < tools.length - 1 && styles.rowDivided,
                  pressed && styles.rowPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={`${tool.title || "Tool"}, ${tool.status.replace("_", " ")}`}
                onPress={() => setOpenId(tool.id)}
              >
                <Ionicons name={ICONS[tool.kind]} size={15} color={theme.color.textDim} />
                <View style={styles.rowText}>
                  <Text style={styles.name} numberOfLines={1}>
                    {tool.title || "Tool"}
                  </Text>
                  {tool.locations?.[0] && (
                    <Text style={styles.description} numberOfLines={1}>
                      {tool.locations[0]}
                    </Text>
                  )}
                </View>
                <Ionicons name={STATUS[tool.status].icon} size={15} color={STATUS[tool.status].color} />
              </Pressable>
            ))
          )}
        </ScrollView>
      </View>
    </Sheet>
  );
}

function ToolDetail({ tool }: { tool: ToolRun }) {
  const content = tool.content ?? [];
  if (content.length === 0) {
    return (
      <Text style={styles.empty}>
        {tool.status === "completed" || tool.status === "failed"
          ? "This tool reported no output."
          : "No output yet."}
      </Text>
    );
  }
  return (
    <View>
      {content.map((block, index) => (
        <ContentBlock key={index} block={block} />
      ))}
    </View>
  );
}

function ContentBlock({ block }: { block: ToolContent }) {
  switch (block.type) {
    case "diff":
      return <Diff path={block.path} oldText={block.oldText} newText={block.newText} />;
    case "content":
      return (
        <Text style={styles.mono} selectable>
          {block.text}
        </Text>
      );
    case "terminal":
      // The output of a terminal lives in the client that created it, and
      // this one does not host terminals.
      return <Text style={styles.empty}>Command output is not streamed by this agent.</Text>;
  }
}

function Diff({ path, oldText, newText }: { path: string; oldText: string; newText: string }) {
  // The whole-file diff is computed once per open, not per render.
  const lines = useMemo(() => hunks(lineDiff(oldText, newText)), [oldText, newText]);
  return (
    <View>
      <Text style={styles.path} numberOfLines={1} selectable>
        {path}
      </Text>
      {lines.map((line, index) =>
        line.kind === "skip" ? (
          <Text key={index} style={[styles.mono, styles.skip]}>
            ⋯ {line.count} unchanged {line.count === 1 ? "line" : "lines"}
          </Text>
        ) : (
          <Text
            key={index}
            style={[
              styles.mono,
              line.kind === "add" && styles.add,
              line.kind === "del" && styles.del,
            ]}
            selectable
          >
            {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "} {line.text}
          </Text>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: sheetCardStyle,
  row: {
    minHeight: SHEET_ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.space(4),
    gap: theme.space(3),
  },
  rowDivided: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
  },
  rowPressed: { backgroundColor: theme.color.surfacePressed },
  rowText: { flex: 1, minWidth: 0, gap: theme.space(0.5) },
  name: {
    color: theme.color.text,
    fontSize: theme.font.body,
    fontWeight: "600",
  },
  description: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
  },
  empty: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    padding: theme.space(4),
  },
  path: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    fontFamily: monospace,
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(2),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
  },
  mono: {
    color: theme.color.text,
    fontFamily: monospace,
    fontSize: theme.font.small,
    lineHeight: theme.line.body,
    paddingHorizontal: theme.space(4),
  },
  // Tinted rows rather than coloured text: readable at any font scale, and
  // the sign at the start carries it for anyone who cannot see the tint.
  add: { backgroundColor: "rgba(63, 185, 80, 0.16)" },
  del: { backgroundColor: "rgba(248, 81, 73, 0.16)" },
  skip: { color: theme.color.textFaint, paddingVertical: theme.space(1) },
});

export const ToolSheet = memo(ToolSheetView);
