/**
 * The drawer's project dropdown, with a search field.
 *
 * Replaces the sideways row of project tabs, which was hard to read and hard
 * to scroll on a phone with many projects. Collapsed it is one full-width
 * control naming the current choice; tapped, it opens inline (not a `Modal`,
 * which would resign the keyboard) into a search field over a vertical,
 * windowed list: "All projects", then projects newest work first (the order
 * `projectsForProvider` gives), then "Another folder…".
 *
 * The list scrolls vertically inside the drawer, whose close swipe is a
 * sideways pan over the whole panel. `listGesture` (a `Gesture.Native()`
 * blocking the drawer swipe) is wrapped round the list so a drag on it scrolls
 * it; anywhere else still closes the drawer.
 */
import { memo, useCallback, useMemo, useState } from "react";
import { GestureDetector, type NativeGesture } from "react-native-gesture-handler";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { withAlpha } from "../motion";
import { haptics } from "./haptics";
import { dashedOutline } from "./stage/DashedRule";
import { useAgentColor } from "./stage/agentColor";
import { searchProjects } from "../projectSearch";
import type { Project } from "../projects";

const ROW_HEIGHT = 44;
/** Rows visible before the list scrolls. */
const VISIBLE_ROWS = 6;

interface ProjectPickerProps {
  projects: readonly Project[];
  /** Undefined means "All projects". */
  selectedPath?: string;
  onSelect: (path?: string) => void;
  /** "Another folder…": absent when the daemon cannot browse. */
  onBrowse?: () => void;
  /** Claims drags on the list ahead of the drawer's close swipe. */
  listGesture?: NativeGesture;
}

type Item = { kind: "all" } | { kind: "project"; project: Project };

function ProjectPickerView({
  projects,
  selectedPath,
  onSelect,
  onBrowse,
  listGesture,
}: ProjectPickerProps) {
  const agent = useAgentColor();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = projects.find((project) => project.path === selectedPath);
  const label = selected?.name ?? "All projects";

  const items = useMemo<Item[]>(() => {
    const found = searchProjects(projects, query).map((project): Item => ({
      kind: "project",
      project,
    }));
    // "All projects" stays reachable whatever is typed: undoing a filter
    // must never need the search cleared first.
    return [{ kind: "all" }, ...found];
  }, [projects, query]);
  const noMatches = items.length === 1 && query.trim() !== "";

  const toggle = () => {
    haptics.tap();
    setOpen((was) => !was);
    setQuery("");
  };

  const pick = useCallback(
    (path?: string) => {
      haptics.select();
      setOpen(false);
      setQuery("");
      if (path !== selectedPath) onSelect(path);
    },
    [onSelect, selectedPath],
  );

  const list = (
    <FlatList
      style={{ maxHeight: ROW_HEIGHT * VISIBLE_ROWS }}
      data={items}
      // Windowed: GG Coder can hold hundreds of projects.
      initialNumToRender={10}
      maxToRenderPerBatch={10}
      windowSize={5}
      keyboardShouldPersistTaps="handled"
      getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
      keyExtractor={(item) => (item.kind === "all" ? "\u0000all" : item.project.path)}
      extraData={selectedPath}
      renderItem={({ item }) => {
        const path = item.kind === "all" ? undefined : item.project.path;
        const isSelected = path === selectedPath;
        const name = item.kind === "all" ? "All projects" : item.project.name;
        return (
          <PickerRow
            label={name}
            a11y={item.kind === "all" ? "All projects" : `Project ${name}`}
            selected={isSelected}
            color={agent}
            onPress={() => pick(path)}
          />
        );
      }}
      ListFooterComponent={
        <>
          {noMatches && <Text style={styles.empty}>No projects match “{query.trim()}”.</Text>}
          {onBrowse && (
            <PickerRow
              label="Another folder…"
              a11y="Another folder. Start a new chat in a folder on your computer"
              icon="folder-open-outline"
              onPress={() => {
                setOpen(false);
                setQuery("");
                onBrowse();
              }}
            />
          )}
        </>
      }
    />
  );

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Project: ${label}`}
        accessibilityHint={open ? "Closes the project list" : "Opens the project list"}
        accessibilityState={{ expanded: open }}
        onPress={toggle}
        style={({ pressed }) => [
          styles.control,
          selected ? { borderStyle: "solid", borderColor: agent } : null,
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.controlText, selected && { color: agent }]} numberOfLines={1}>
          {label}
        </Text>
        <Ionicons
          name={open ? "chevron-up" : "chevron-down"}
          size={16}
          color={theme.color.textDim}
        />
      </Pressable>
      {open && (
        <View style={styles.panel}>
          <ProjectSearchField value={query} onChange={setQuery} />
          {listGesture ? <GestureDetector gesture={listGesture}>{list}</GestureDetector> : list}
        </View>
      )}
    </View>
  );
}

export const ProjectPicker = memo(ProjectPickerView);

/** The search box, shared with New chat's project list. */
export function ProjectSearchField({
  value,
  onChange,
}: {
  value: string;
  onChange: (text: string) => void;
}) {
  return (
    <View style={styles.search}>
      <Ionicons name="search-outline" size={16} color={theme.color.textDim} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Search projects (* for any)"
        placeholderTextColor={theme.color.textFaint}
        accessibilityLabel="Search projects. Use a star as a wildcard"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={styles.searchInput}
      />
      {value !== "" && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={8}
          onPress={() => onChange("")}
        >
          <Ionicons name="close-circle" size={16} color={theme.color.textDim} />
        </Pressable>
      )}
    </View>
  );
}

const PickerRow = memo(function PickerRow({
  label,
  a11y,
  selected = false,
  color,
  icon,
  onPress,
}: {
  label: string;
  a11y: string;
  selected?: boolean;
  color?: string;
  icon?: "folder-open-outline";
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        selected && color ? { backgroundColor: withAlpha(color, 0.1) } : null,
        pressed && styles.pressed,
      ]}
    >
      {icon && <Ionicons name={icon} size={16} color={theme.color.textDim} />}
      <Text
        style={[styles.rowText, selected && color ? { color } : null]}
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {label}
      </Text>
      {selected && <Ionicons name="checkmark" size={16} color={color} />}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  wrap: { marginTop: theme.space(4) },
  control: {
    ...dashedOutline,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    minHeight: theme.size.touch,
    paddingHorizontal: theme.space(3),
    borderRadius: theme.radius.pill,
  },
  controlText: { flex: 1, color: theme.color.text, fontSize: theme.font.body },
  panel: {
    marginTop: theme.space(2),
    borderRadius: theme.space(3),
    backgroundColor: theme.color.surfaceRaised,
    overflow: "hidden",
  },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingHorizontal: theme.space(3),
    minHeight: theme.size.touch,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.textFaint,
  },
  searchInput: {
    flex: 1,
    color: theme.color.text,
    fontSize: theme.font.body,
    paddingVertical: theme.space(2),
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    height: ROW_HEIGHT,
    paddingHorizontal: theme.space(3),
  },
  rowText: { flex: 1, color: theme.color.textDim, fontSize: theme.font.body },
  empty: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
  },
  pressed: { opacity: 0.6 },
});
