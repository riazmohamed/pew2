/**
 * The sidebar drawer: the Switchboard.
 *
 * A rail of Pews down the left, one per agent (the chosen one awake with a lit
 * bar, the rest dozing), and the chosen agent's world on the right: its name,
 * the connection on one LED line, project tabs, then its latest chats.
 *
 * This is a push drawer: the conversation slides right to reveal it, so the
 * panel itself is static. App owns the motion.
 */
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Gesture, type PanGesture } from "react-native-gesture-handler";
import {
  Alert,
  Dimensions,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { withAlpha } from "../motion";
import { CircleButton, touchSlop } from "./controls";
import { haptics } from "./haptics";
import { agentSound } from "../soundsPolicy";
import { HistorySkeleton } from "./Skeleton";
import { orderProvidersByRecency } from "../providerRecency";
import type { DrawerRow } from "../historyMetadata";
import { recentSessionsForProvider } from "../sessionHistory";
import { useAppActive } from "./useAppActive";
import { useDrawerWidth } from "./useDrawerWidth";
import { sessionsInProject, type Project } from "../projects";
import { ProjectPicker } from "./ProjectPicker";
import type { Provider, Status } from "../useDaemon";
import { lastActiveLabel, sortGoals, type GoalSummary } from "../ggState";
import { goalDrawerRow } from "../goalsAgent";
import { Pew } from "../pew/Pew";
import { pewInk } from "../pew/palette";
import { Led } from "./stage/Led";
import { Pixel } from "./stage/Pixel";
import { DashedRule } from "./stage/DashedRule";
import { useAgentColor } from "./stage/agentColor";
import { Dissolve } from "./motion/Dissolve";
import { DotGlyph } from "./stage/DotGlyph";

/*
 * The whole screen: the drawer is a page of its own now, with room for long
 * titles and the full chat list. The conversation slides fully out to its
 * right, so the drawer carries its own close (a button and a left swipe). The
 * width is read per render (`useDrawerWidth`) because the app rotates.
 */

interface SidebarProps {
  open: boolean;
  /**
   * The drawer's own swipe-to-close. A drag that starts on the open project
   * list scrolls the projects instead.
   */
  closeGesture?: PanGesture;
  providers: Provider[];
  sessions: DrawerRow[];
  activeProviderId?: string;
  activeSessionId?: string;
  onSelectProvider: (id: string) => void;
  onOpenSession: (id: string) => void;
  /**
   * Conversations currently holding an agent process on the desktop.
   *
   * Only these get a close control, because only these have anything to close.
   * The daemon caps it at four, so this is a short list even when the drawer
   * holds hundreds of rows.
   */
  liveSessionIds?: string[];
  /** Ends the agent process, keeping the conversation. */
  onCloseSession?: (id: string) => void;
  /**
   * A new chat in a folder this agent has never been used in: opens the
   * new-chat sheet straight at its folder browser. Absent hides the tab.
   */
  onBrowseFolder?: () => void;
  /**
   * Starts a conversation in `cwd`.
   *
   * Always called with one: the only button that reaches this is beside a named
   * project, which is what replaced a header button that could not say where
   * its chat would go.
   */
  /** A new chat: in the chosen project, or (on All) where this agent last worked. */
  onNewConversation: (cwd?: string) => void;
  /** Projects the selected agent has worked in, newest first. */
  projects: Project[];
  /** The chosen one, or undefined for all of them. */
  selectedProjectPath?: string;
  /** `undefined` clears the filter back to every project. */
  onSelectProject: (path?: string) => void;
  /** Host and port, retained for accessible detail and the Forget confirmation. */
  machineLabel: string;
  /** True when reached via a relay, so it works away from home. */
  machineRemote: boolean;
  connectionStatus: Status;
  onOpenConnection: () => void;
  /** Close the drawer (it covers the whole screen, so it needs its own way out). */
  onClose?: () => void;
  /**
   * A newer pew2 the paired computer has not got, when there is one.
   *
   * Absent for the ordinary case, including a machine that updates itself — by
   * the time anyone could read a notice about it, it has already happened.
   */
  update?: { latest: string; automatic: boolean };
  /**
   * Agents are still answering what conversations they hold. Without this the
   * drawer claims "No conversations yet" for the first seconds after connect —
   * a false empty state on machines with plenty of history.
   */
  historyLoading?: boolean;
  /** Honor the phone's Reduce Motion accessibility preference. */
  reduceMotion?: boolean;
  /**
   * GG Goals selected: its goals replace the project picker and the chat
   * history (goal sessions are never mixed into another agent's list). They
   * are drawn by this file's own heading, list and `SessionRow`, so the two
   * lists cannot drift apart.
   */
  goals?: SidebarGoals;
}

export interface SidebarGoals {
  /** Absent until the first answer arrives (shows the same skeleton as chats). */
  list?: readonly GoalSummary[];
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  onNew: () => void;
  onOpen: (goal: GoalSummary) => void;
  onDelete: (goal: GoalSummary) => void;
}

/**
 * Rows that cascade in on open: as many as a screen could ever show (a row
 * is at least `touch` tall), and the lists render that many up front, so
 * every row on the first screen is mounted in time for its slot. Rows below
 * that (scrolled into view later) just appear.
 */
const STAGGERED_ROWS = Math.ceil(Dimensions.get("window").height / theme.size.touch);
const ROW_STAGGER_MS = 28;
const RAIL_WIDTH = 64;

/** A short name under each rail Pew, so the agents read apart at a glance. */
const RAIL_NAMES: Record<string, string> = {
  ggcoder: "OG",
  "gg-goals": "Goals",
  "claude-code": "Claude",
};
function railName(provider: { id: string; name: string }): string {
  return RAIL_NAMES[provider.id] ?? provider.name.split(/\s+/)[0]!.slice(0, 7);
}
const RAIL_PEW = 40;
const RAIL_BUTTON = 52;
/** The right column's own left rail: every heading, tab and row starts here. */
const COLUMN_PAD = theme.space(4);
/** Fixed status column so every row's title starts at the same x. */
const STATUS_COL = 16;

type Mark = "live" | "attention" | "unread" | undefined;

function rowMark(row: Pick<DrawerRow, "busy" | "unread"> & { permission?: unknown }): Mark {
  if (row.permission) return "attention";
  if (row.busy) return "live";
  if (row.unread) return "unread";
  return undefined;
}

/** "4m", "2h", "3d": the right-hand time, short so the title keeps the room. */
function shortWhen(ms?: number): string {
  if (!ms) return "";
  const label = lastActiveLabel(ms);
  return label === "just now" ? "now" : label.replace(" ago", "");
}

interface SessionRowProps {
  session: Pick<DrawerRow, "id" | "title" | "busy" | "unread"> & Partial<DrawerRow>;
  /** Spoken detail when the row is not a chat (a goal's status · when). */
  meta?: string;
  onLongPress?: (id: string) => void;
  index: number;
  active: boolean;
  reduceMotion: boolean;
  /** Shut drawer, or app in the background. */
  paused: boolean;
  /** Takes the id, so one stable callback serves every row. */
  onOpen: (id: string) => void;
  /** When the drawer last opened (epoch ms; 0 = not yet): the cascade's shared clock. */
  cascadeAt: number;
  /**
   * This conversation is holding an agent process on the desktop right now.
   *
   * The close control appears only for these. Every other row is already just
   * an entry in the agent's own history, so offering to close one would promise
   * an action with nothing behind it, and worse, read as "delete".
   */
  live?: boolean;
  /** Takes the id for the same reason `onOpen` does. */
  onClose?: (id: string) => void;
}

/**
 * Let go of the agent this conversation is holding.
 *
 * Deliberately not a delete, and shaped to say so: a power glyph rather than a
 * cross or a bin, and the row it belongs to stays exactly where it is
 * afterwards. The conversation is on the agent's disk; this is only the running
 * process. At most four conversations hold an agent at once (the daemon caps
 * it), so this stays rare enough not to be clutter.
 */
function CloseAgentButton({
  title,
  busy,
  onPress,
}: {
  title: string;
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      // Names the conversation, because in a list of rows "Close" alone leaves
      // a screen reader user with no idea which one they are on.
      accessibilityLabel={`Close the running agent for ${title}`}
      accessibilityHint="Frees memory on your computer. The conversation is kept and reopens where it left off."
      hitSlop={touchSlop(theme.space(2))}
      onPress={() => {
        // Interrupting work is a decision worth a beat; releasing an idle agent
        // is housekeeping. Only the first one asks.
        if (!busy) {
          haptics.tap();
          onPress();
          return;
        }
        haptics.warned();
        Alert.alert(
          "Stop and close?",
          `${title} is working. Closing stops it and frees the memory. The conversation is kept, and reopening it picks up where it left off.`,
          [
            { text: "Keep running", style: "cancel" },
            { text: "Stop and close", style: "destructive", onPress },
          ],
        );
      }}
      style={({ pressed }) => [styles.closeAgent, pressed && styles.pressed]}
    >
      <Ionicons name="power" size={14} color={theme.color.textDim} />
    </Pressable>
  );
}

/**
 * Sleeping styles down the rail, by position: a fixed shuffle of all ten, so
 * no two neighbours (and no two of the first ten) ever doze the same way.
 */
const RAIL_SLEEP = [0, 5, 8, 3, 7, 2, 9, 4, 6, 1] as const;

const SessionRow = memo(function SessionRow({
  session,
  index,
  active,
  reduceMotion,
  paused,
  onOpen,
  meta,
  onLongPress,
  cascadeAt,
  live,
  onClose,
}: SessionRowProps) {
  // The cascade is keyed to the drawer opening, not to a row's mount: each row
  // takes its slot (index × stagger) from that one moment, so a row the list
  // mounts in a later batch still lands after the one above it, and a row that
  // mounts long after (behind a shut drawer, a re-render) just appears.
  const agent = useAgentColor();
  const mark = rowMark(session);
  const when = shortWhen(session.startedAt);
  const status =
    mark === "live"
      ? "Working"
      : mark === "attention"
        ? "Waiting on you"
        : mark === "unread"
          ? "New reply"
          : undefined;
  return (
    <Dissolve
      kind="row"
      dissolveKey={cascadeAt}
      startAt={cascadeAt + index * ROW_STAGGER_MS}
      enabled={!reduceMotion && cascadeAt > 0 && index < STAGGERED_ROWS}
    >
      {index > 0 && <DashedRule />}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[session.title, status, meta ?? (when ? `${when} ago` : undefined)]
          .filter(Boolean)
          .join(", ")}
        accessibilityState={{ selected: active }}
        onPress={() => {
          haptics.select();
          onOpen(session.id);
        }}
        onLongPress={onLongPress ? () => onLongPress(session.id) : undefined}
        style={({ pressed }) => [
          styles.row,
          active && { backgroundColor: withAlpha(agent, 0.1) },
          pressed && styles.pressed,
        ]}
      >
        {/* The title starts on the column's rail, under "Latest chats"; the
            status marker sits at the right edge beside the time, so a marked
            row never indents. */}
        <Text style={[styles.rowTitle, active && { color: agent }]} numberOfLines={1}>
          {session.title}
        </Text>
        {mark ? (
          <View style={styles.statusCol}>
            <Pixel kind={mark} paused={paused} />
          </View>
        ) : null}
        {when ? (
          <Text style={styles.rowWhen} numberOfLines={1}>
            {when}
          </Text>
        ) : null}
        {/* Inside the row on screen, its own target: tapping the title opens,
            tapping this closes, and the two do not overlap. */}
        {live && onClose ? (
          <CloseAgentButton
            title={session.title}
            busy={session.busy === true}
            onPress={() => onClose(session.id)}
          />
        ) : null}
      </Pressable>
    </Dissolve>
  );
});

/** "+ New chat" / "+ New goal": an LED action on the list heading's line. */
function LedAction({ label, a11y, onPress }: { label: string; a11y: string; onPress: () => void }) {
  return (
    <Dissolve kind="in">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={a11y}
        hitSlop={touchSlop(theme.space(2))}
        onPress={() => {
          haptics.tap();
          onPress();
        }}
        style={({ pressed }) => [styles.ledAction, pressed && styles.pressed]}
      >
        <Led>{`+ ${label}`}</Led>
      </Pressable>
    </Dissolve>
  );
}

function ListHead({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <View style={styles.listHead}>
      <Led tone="dim">{label}</Led>
      {children}
    </View>
  );
}

/** GG Goals' half of the drawer: its goals in the same row style as chats. */
function GoalsSection({
  goals,
  activeSessionId,
  reduceMotion,
  paused,
  cascadeAt,
}: {
  goals: SidebarGoals;
  activeSessionId?: string;
  reduceMotion: boolean;
  paused: boolean;
  cascadeAt: number;
}) {
  const sorted = useMemo(() => sortGoals([...(goals.list ?? [])]), [goals.list]);
  const byId = useMemo(() => new Map(sorted.map((goal) => [goal.id, goal])), [sorted]);
  // The system spinner only ever answers a pull the user made.
  const [pulled, setPulled] = useState(false);
  useEffect(() => {
    if (!goals.loading) setPulled(false);
  }, [goals.loading]);
  const { onOpen, onDelete } = goals;
  const open = useCallback(
    (id: string) => {
      const goal = byId.get(id);
      if (!goal) return;
      haptics.tap();
      onOpen(goal);
    },
    [byId, onOpen],
  );
  const confirmDelete = useCallback(
    (id: string) => {
      const goal = byId.get(id);
      if (!goal) return;
      haptics.warned();
      Alert.alert(
        "Delete goal?",
        `“${goal.name}” will be removed from GG Goals on your computer.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => onDelete(goal) },
        ],
      );
    },
    [byId, onDelete],
  );

  return (
    <>
      <ListHead label="Latest goals">
        <LedAction label="New goal" a11y="New goal" onPress={goals.onNew} />
      </ListHead>
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        data={sorted}
        extraData={`${activeSessionId ?? ""}:${reduceMotion}:${paused}:${cascadeAt}`}
        keyExtractor={(goal) => goal.id}
        initialNumToRender={STAGGERED_ROWS}
        maxToRenderPerBatch={STAGGERED_ROWS}
        refreshControl={
          <RefreshControl
            refreshing={pulled && goals.loading}
            onRefresh={() => {
              setPulled(true);
              goals.onRefresh();
            }}
            tintColor={theme.color.textDim}
          />
        }
        ListEmptyComponent={
          goals.list === undefined && !goals.error ? (
            <HistorySkeleton label="Loading goals" />
          ) : (
            <Text style={styles.empty} numberOfLines={2}>
              {goals.error ?? "No goals yet. Start one with New goal."}
            </Text>
          )
        }
        renderItem={({ item: goal, index }) => {
          const { row, meta } = goalDrawerRow(goal, lastActiveLabel(goal.lastActiveMs));
          return (
            <SessionRow
              session={row}
              meta={meta}
              index={index}
              active={goal.sessionId !== undefined && goal.sessionId === activeSessionId}
              reduceMotion={reduceMotion}
              paused={paused}
              cascadeAt={cascadeAt}
              onOpen={open}
              onLongPress={confirmDelete}
            />
          );
        }}
      />
    </>
  );
}

/** One agent on the rail: its Pew, a tinted tile when chosen (no edge bar: the user wants no coloured left edges anywhere), a status pixel. */
const RailAgent = memo(function RailAgent({
  provider,
  selected,
  mark,
  index,
  paused,
  reduceMotion,
  onPress,
}: {
  provider: Provider;
  selected: boolean;
  mark: Mark;
  index: number;
  paused: boolean;
  reduceMotion: boolean;
  onPress: (id: string) => void;
}) {
  const enabled = provider.available;
  const ink = pewInk(provider.color);
  const [revealing] = useState(() => !paused);
  const spoken =
    mark === "attention"
      ? "needs you"
      : mark === "live"
        ? "working"
        : mark === "unread"
          ? "new reply"
          : undefined;
  return (
    <Dissolve kind="in" delay={index * ROW_STAGGER_MS} enabled={!reduceMotion && revealing}>
      <Pressable
        disabled={!enabled}
        accessibilityRole="button"
        accessibilityLabel={
          enabled
            ? [provider.name, spoken].filter(Boolean).join(", ")
            : `${provider.name}, unavailable. ${provider.unavailableReason ?? ""}`
        }
        accessibilityState={{ selected, disabled: !enabled }}
        onPress={() => {
          if (selected) return;
          haptics.chosen(agentSound(provider.id));
          onPress(provider.id);
        }}
        style={({ pressed }) => [
          styles.railButton,
          selected && { backgroundColor: withAlpha(ink, 0.13) },
          !enabled && styles.unavailable,
          pressed && styles.pressed,
        ]}
      >
        <Pew
          size={RAIL_PEW}
          color={provider.color}
          mood={!enabled ? "sleepy" : selected ? "idle" : "sleepy"}
          sleepKey={provider.id}
          sleepStyle={RAIL_SLEEP[index % RAIL_SLEEP.length]}
          paused={paused || !enabled}
        />
        <Text
          style={[styles.railLabel, { color: selected ? ink : theme.color.textDim }]}
          numberOfLines={1}
        >
          {railName(provider)}
        </Text>
        {mark && (
          <View style={styles.railBadge}>
            <Pixel kind={mark} color={mark === "attention" ? undefined : ink} paused={paused} />
          </View>
        )}
      </Pressable>
    </Dissolve>
  );
});

function SidebarView({
  open,
  providers,
  sessions,
  activeProviderId,
  activeSessionId,
  onSelectProvider,
  onOpenSession,
  liveSessionIds,
  onCloseSession,
  onBrowseFolder,
  onNewConversation,
  projects,
  selectedProjectPath,
  onSelectProject,
  machineLabel,
  machineRemote,
  connectionStatus,
  onOpenConnection,
  onClose,
  update,
  historyLoading = false,
  reduceMotion = false,
  goals,
  closeGesture,
}: SidebarProps) {
  const insets = useSafeAreaInsets();
  // The project list's scroll, claimed before the drawer's close swipe: a
  // drag that starts on the list scrolls it, anywhere else still closes.
  const tabsGesture = useMemo(() => {
    const native = Gesture.Native();
    return closeGesture ? native.blocksExternalGesture(closeGesture) : native;
  }, [closeGesture]);
  const width = useDrawerWidth();
  const appActive = useAppActive();
  // Nothing animates while the drawer is shut or the app is off screen.
  const rowsStill = !open || !appActive;
  // Stamped each time the drawer opens: every visible row cascades from here.
  const [cascadeAt, setCascadeAt] = useState(0);
  useEffect(() => {
    if (open) setCascadeAt(Date.now());
  }, [open]);

  // GG Coder and GG Goals pinned first, then most recently used.
  const orderedProviders = useMemo(
    () => orderProvidersByRecency(providers, sessions),
    [providers, sessions],
  );
  const activeProvider = orderedProviders.find((p) => p.id === activeProviderId);

  // One status per agent for its rail Pew: needs you > working > unread.
  const marks = useMemo(() => {
    const out = new Map<string, Mark>();
    const rank = { attention: 3, live: 2, unread: 1 } as const;
    for (const row of sessions) {
      const mark = rowMark(row);
      if (!mark || !row.providerId) continue;
      const was = out.get(row.providerId);
      if (!was || rank[mark] > rank[was]) out.set(row.providerId, mark);
    }
    return out;
  }, [sessions]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.path === selectedProjectPath),
    [projects, selectedProjectPath],
  );
  // Narrowed before the recent-work cap, or a project's older conversations
  // would be cut away by a window they were never in.
  const visible = useMemo(
    () => recentSessionsForProvider(sessionsInProject(sessions, selectedProject), activeProviderId),
    [sessions, selectedProject, activeProviderId],
  );

  // A Set because every visible row asks. The array is at most four ids.
  const live = useMemo(() => new Set(liveSessionIds ?? []), [liveSessionIds]);
  const closeRow = useCallback((id: string) => onCloseSession?.(id), [onCloseSession]);

  const openRow = useCallback(
    (id: string) => {
      haptics.tap();
      onOpenSession(id);
    },
    [onOpenSession],
  );

  const connection =
    connectionStatus === "online"
      ? { word: "Online", tone: "plus" as const, spoken: "Healthy connection" }
      : connectionStatus === "connecting"
        ? { word: "Connecting", tone: "attention" as const, spoken: "Connecting" }
        : { word: "Offline", tone: "danger" as const, spoken: "Connection interrupted" };

  return (
    <View
      style={[styles.panel, { width }]}
      pointerEvents={open ? "auto" : "none"}
      // Mounted while closed, but not on screen: unreachable by swipe navigation.
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
    >
      {/* The drawer starts at the physical left edge, which in landscape is
          under the notch on one of the two ways round. */}
      <View
        style={[
          styles.board,
          { paddingTop: insets.top + theme.headerInset, paddingLeft: insets.left },
        ]}
      >
        <View
          style={[styles.rail, { paddingBottom: insets.bottom + theme.space(4) }]}
          accessibilityRole="tablist"
          accessibilityLabel="Agents"
        >
          <DashedRule vertical style={styles.railEdge} />
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.railList}>
            {orderedProviders.map((provider, index) => (
              <RailAgent
                key={provider.id}
                provider={provider}
                selected={provider.id === activeProviderId}
                mark={marks.get(provider.id)}
                index={index}
                paused={rowsStill}
                reduceMotion={reduceMotion}
                onPress={onSelectProvider}
              />
            ))}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Connection details for ${machineLabel}${update ? (update.automatic ? ", updating pew2" : ", update available") : ""}`}
            hitSlop={touchSlop(theme.space(1))}
            onPress={() => {
              haptics.tap();
              onOpenConnection();
            }}
            style={({ pressed }) => [styles.railButton, pressed && styles.pressed]}
          >
            <Ionicons name="settings-outline" size={22} color={theme.color.textDim} />
            {update && (
              <View style={styles.railBadge}>
                <Pixel kind="attention" paused={rowsStill} />
              </View>
            )}
          </Pressable>
        </View>

        {/* The bottom inset here as well as on the rail: the list's last rows
            otherwise sit in the home indicator's gesture strip. */}
        <View
          style={[
            styles.main,
            { paddingBottom: insets.bottom + theme.space(4), paddingRight: insets.right },
          ]}
        >
          <View style={styles.head}>
            <View style={styles.headTop}>
              <Text
                style={[styles.agentName, { color: pewInk(activeProvider?.color) }]}
                numberOfLines={1}
              >
                {activeProvider?.name ?? "Agents"}
              </Text>
              {/* Full width now, so nothing of the conversation is left to tap:
                  the drawer closes itself. */}
              {onClose && (
                <CircleButton label="Close menu" onPress={onClose}>
                  <DotGlyph name="close" size={14} />
                </CircleButton>
              )}
            </View>
            <View
              accessibilityRole="text"
              accessibilityLabel={`${connection.spoken} to ${machineLabel}. ${machineRemote ? "Reachable from anywhere." : "Same network only."}`}
            >
              {/* Status only: the relay or host name is internal plumbing, and
                  the connection sheet has the details when they're wanted. */}
              <Led tone={connection.tone}>{connection.word}</Led>
            </View>
          </View>

          {goals ? (
            <GoalsSection
              goals={goals}
              activeSessionId={activeSessionId}
              reduceMotion={reduceMotion}
              paused={rowsStill}
              cascadeAt={cascadeAt}
            />
          ) : (
            <>
              {/* A dropdown with search: the old sideways row of tabs was
                  hard to read and to scroll with many projects. */}
              {(projects.length > 0 || onBrowseFolder) && (
                <View style={styles.picker}>
                  <ProjectPicker
                    key={activeProviderId ?? "all-providers"}
                    projects={projects}
                    selectedPath={selectedProject?.path}
                    onSelect={onSelectProject}
                    onBrowse={onBrowseFolder}
                    listGesture={tabsGesture}
                  />
                </View>
              )}

              <ListHead label="Latest chats">
                {/* Always here, like New goal for GG Goals. With a project tab
                    chosen it opens there; on All it opens where this agent
                    last worked (the composer names the project, and it can be
                    changed from there before sending). */}
                <LedAction
                  key={selectedProject?.path ?? "all"}
                  label="New chat"
                  a11y={selectedProject ? `New chat in ${selectedProject.name}` : "New chat"}
                  onPress={() => onNewConversation(selectedProject?.path)}
                />
              </ListHead>

              {/* Windowed: a provider can hold hundreds of conversations. */}
              <FlatList
                // Remount on agent or project: scroll resets and rows enter once.
                key={`${activeProviderId ?? "all-providers"}:${selectedProjectPath ?? "all"}`}
                style={styles.list}
                contentContainerStyle={styles.listContent}
                showsVerticalScrollIndicator={false}
                data={visible}
                // The live set joins this, or a row would keep offering to close
                // an agent the reaper has already taken.
                extraData={`${activeSessionId ?? ""}:${reduceMotion}:${rowsStill}:${cascadeAt}:${liveSessionIds?.join(",") ?? ""}`}
                keyExtractor={(session) => session.id}
                initialNumToRender={STAGGERED_ROWS}
                maxToRenderPerBatch={STAGGERED_ROWS}
                windowSize={9}
                ListEmptyComponent={
                  historyLoading ? (
                    <HistorySkeleton />
                  ) : (
                    <Text style={styles.empty} numberOfLines={2}>
                      {selectedProject
                        ? `No chats in ${selectedProject.name} yet.`
                        : "No chats yet. Send a message to start one."}
                    </Text>
                  )
                }
                renderItem={({ item: session, index }) => (
                  <SessionRow
                    session={session}
                    index={index}
                    active={session.id === activeSessionId}
                    reduceMotion={reduceMotion}
                    paused={rowsStill}
                    cascadeAt={cascadeAt}
                    onOpen={openRow}
                    live={live.has(session.id)}
                    onClose={closeRow}
                  />
                )}
              />
            </>
          )}
        </View>
      </View>
      {/* The drawer's edge, dashed like every other Stage rule. iOS draws a
          dashed border only on a box with all four sides, so this is a dashed
          box whose left, top and bottom run just outside the panel and are
          clipped away, leaving the right edge and its curved corners. */}
      <View style={styles.edge} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  // Static lower layer: the conversation slides right to reveal it.
  panel: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: theme.color.drawer,
    borderTopRightRadius: theme.radius.pane,
    borderBottomRightRadius: theme.radius.pane,
    overflow: "hidden",
  },
  edge: {
    position: "absolute",
    top: -2,
    bottom: -2,
    left: -2,
    right: 0,
    borderWidth: 1,
    borderStyle: "dashed",
    // Brighter than an in-panel rule: it draws the drawer's curved edge
    // against a canvas of nearly the same colour.
    borderColor: "rgba(255,255,255,0.28)",
    borderTopRightRadius: theme.radius.pane,
    borderBottomRightRadius: theme.radius.pane,
  },
  board: { flex: 1, flexDirection: "row" },
  pressed: { opacity: 0.6 },
  unavailable: { opacity: 0.4 },

  rail: {
    width: RAIL_WIDTH,
    alignItems: "center",
  },
  // A one-sided dashed border is not drawable on iOS: the rail's edge is a
  // vertical dashed rule laid over it instead.
  railEdge: { position: "absolute", top: 0, bottom: 0, right: 0 },
  railList: { alignItems: "center", gap: theme.space(1), paddingBottom: theme.space(2) },
  railLabel: {
    marginTop: 2,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: "600",
    textAlign: "center",
    maxWidth: RAIL_WIDTH - 4,
  },
  railButton: {
    width: RAIL_BUTTON,
    // Room for the short name under the Pew.
    height: RAIL_BUTTON + 12,
    borderRadius: theme.space(4),
    alignItems: "center",
    justifyContent: "center",
  },
  railBadge: { position: "absolute", top: theme.space(1), right: theme.space(1) },

  main: { flex: 1, minWidth: 0, paddingBottom: theme.space(4) },
  // The close button sits on the screen's own right rail (`theme.gutter`), the
  // spot the main screen's right-hand button occupies, like every page header.
  head: {
    paddingLeft: COLUMN_PAD,
    paddingRight: theme.gutter,
    gap: theme.space(1),
    minHeight: theme.size.control,
    justifyContent: "center",
  },
  headTop: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  agentName: {
    flex: 1,
    minWidth: 0,
    fontFamily: theme.display.regular,
    fontSize: theme.font.title,
    letterSpacing: 0.5,
  },

  picker: { paddingHorizontal: COLUMN_PAD },

  listHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space(2),
    paddingHorizontal: COLUMN_PAD,
    marginTop: theme.space(5),
    // Constant height with or without the action, so choosing a project never shoves the list.
    minHeight: theme.size.touch,
  },
  ledAction: { minHeight: theme.size.touch, justifyContent: "center" },

  list: { flex: 1 },
  listContent: { paddingHorizontal: COLUMN_PAD },
  // The selected row's fill reaches a little past the rail on both sides
  // (negative margin, matching padding), so the text itself stays on it.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    minHeight: theme.size.touch,
    paddingVertical: theme.space(2),
    marginHorizontal: -theme.space(2),
    paddingHorizontal: theme.space(2),
    borderRadius: theme.radius.sm,
  },
  statusCol: { width: STATUS_COL, alignItems: "center", justifyContent: "center" },
  rowTitle: {
    flex: 1,
    color: theme.color.text,
    fontSize: theme.font.body,
    lineHeight: theme.line.body,
  },
  rowWhen: { color: theme.color.textDim, fontSize: theme.font.tiny },
  // After the time, quiet: housekeeping must never compete with the title.
  closeAgent: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
  },
  empty: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    lineHeight: 20,
    paddingTop: theme.space(2),
  },
});

// Memoized: a streamed chunk re-renders the screen many times a second, and
// none of those chunks change anything here.
export const Sidebar = memo(SidebarView);
