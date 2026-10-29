/**
 * The main screen's nav: menu, title, the goal controls or new-conversation
 * button, the ticker and a goal's crew, over the frosted cover for its zone.
 */
import { useState, type Dispatch, type SetStateAction } from "react";
import { Alert, Modal, Platform, Pressable, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import {
  anyOpen,
  closeLabel,
  deskActions,
  deskTargetLabel,
  needsSheet,
  openWindows,
  type DeskAction,
  type DeskTarget,
} from "../deskChoice";
import type { EdgeInsets } from "react-native-safe-area-context";
import { theme } from "../theme";
import { styles } from "../appStyles";
import type { Provider, useDaemon } from "../useDaemon";
import type { useGoalControls } from "../useGoalControls";
import { CircleButton } from "./controls";
import { DotGlyph } from "./stage/DotGlyph";
import { Ticker } from "./Ticker";
import { Dissolve } from "./motion/Dissolve";
import { CrewRow } from "./CrewRow";
import { CanvasCover } from "./CanvasCover";
import { PEW_VOICE_COLOR } from "../pew/palette";

export function ScreenTopBar({
  daemon,
  goals,
  insets,
  navHeight,
  setNavHeight,
  setMenuOpen,
  onNewChat,
  onHome,
  sessionTitle,
  inThread,
  holdingRestore,
  active,
  onOpenTools,
  onTalk,
  onTalkHold,
  talkArmed = false,
}: {
  daemon: ReturnType<typeof useDaemon>;
  goals: ReturnType<typeof useGoalControls>;
  insets: EdgeInsets;
  navHeight: number;
  setNavHeight: Dispatch<SetStateAction<number>>;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  onNewChat: () => void;
  /** Back to the home dashboard, from a conversation not yet started. Absent hides it. */
  onHome?: () => void;
  sessionTitle: string;
  inThread: boolean;
  holdingRestore: boolean;
  active: Provider | undefined;
  /** Opens the tool sheet: each step's own output and diff. */
  onOpenTools?: () => void;
  /** Start a call with Pew; absent hides the button (no voice on this daemon). */
  onTalk?: () => void;
  /** Hold Talk: the voice settings, where this conversation can be armed to ring. */
  onTalkHold?: () => void;
  /** This conversation may ring the phone: a dot in Pew's colour on Talk. */
  talkArmed?: boolean;
}) {
  const {
    inGoal,
    goalPaused,
    goalId,
    resumeGoal,
    pauseGoal,
    openGoalSettings,
    askHere,
    kenSays,
    goalState,
  } = goals;
  // The ticker's step list drops over the crew row, which is drawn after it
  // and so on top: the row fades out while the list is open.
  const [stepsOpen, setStepsOpen] = useState(false);
  // How many controls sit right of the title: a goal's two, or Talk beside compose.
  const twoRight = inGoal || (onTalk !== undefined && (inThread || onHome !== undefined));
  return (
    <>
      {/* Absolute over the thread: messages scroll beneath the nav and fade
          out under the CanvasCover instead of hitting a panel edge, so the
          conversation keeps the full screen height. */}
      <View
        style={[styles.topBarOverlay, { top: insets.top }]}
        onLayout={(e) => setNavHeight(e.nativeEvent.layout.height)}
      >
        <View style={styles.topBar}>
          {/* Both sides the same fixed width, sized for the wider one, so the
            title is centred on the screen and is what gives way: it truncates
            instead of pushing a button off the edge. Two controls on the right
            in a goal, and in a thread when voice adds Talk beside compose. */}
          <View style={twoRight ? [styles.navActionsGoal, styles.navLeadGoal] : styles.navAction}>
            {/* The dot below is pinned to this box, so it stays on the menu
              button however wide the side it sits in is. */}
            <View>
              <CircleButton
                label={`Open menu. Daemon ${daemon.status}.`}
                onPress={() => setMenuOpen(true)}
              >
                <DotGlyph name="menu" size={16} />
              </CircleButton>
              {/* Connection state as a dot on the menu button: always visible, but
              it never competes with the model name for space. */}
              {daemon.status !== "online" && (
                <View
                  style={[
                    styles.statusDot,
                    {
                      backgroundColor:
                        daemon.status === "connecting" ? theme.color.accent : theme.color.danger,
                    },
                  ]}
                />
              )}
            </View>
          </View>

          {/* Re-keyed per title: opening a chat swaps the name in rather than cutting. */}
          <Dissolve kind="swap" dissolveKey={sessionTitle} style={titleBox}>
            <Text
              // The wrapper takes the row's `flex: 1`; inside its column the title's
              // own `flex: 1` would size it from zero height and pin it to the top.
              style={[styles.sessionTitle, titleText]}
              numberOfLines={1}
              ellipsizeMode="tail"
              accessibilityRole="header"
              accessibilityLabel={sessionTitle}
            >
              {sessionTitle}
            </Text>
          </Dissolve>

          <DeskButton daemon={daemon} inThread={inThread} active={active} />
          <View style={twoRight ? styles.navActionsGoal : styles.navAction}>
            {inGoal ? (
              // A goal is one long conversation, so there is no "new conversation"
              // here: its two controls take the spot instead of a card over the thread.
              <>
                <CircleButton
                  label={goalPaused ? "Resume goal" : "Pause goal"}
                  disabled={!goalId}
                  onPress={goalPaused ? resumeGoal : pauseGoal}
                >
                  <DotGlyph name={goalPaused ? "play" : "pause"} size={14} />
                </CircleButton>
                <CircleButton label="Goal settings" disabled={!goalId} onPress={openGoalSettings}>
                  <DotGlyph name="gear" size={16} />
                </CircleButton>
              </>
            ) : (
              <>
                {onTalk && (
                  <View>
                    <CircleButton
                      label={
                        talkArmed
                          ? "Talk to Pew. This conversation rings you when it needs you."
                          : "Talk to Pew"
                      }
                      onPress={onTalk}
                      onLongPress={onTalkHold}
                    >
                      <DotGlyph name="call" size={16} />
                    </CircleButton>
                    {talkArmed && (
                      <View
                        pointerEvents="none"
                        style={[styles.statusDot, { backgroundColor: PEW_VOICE_COLOR }]}
                      />
                    )}
                  </View>
                )}
                {inThread && (
                  // Asks where, rather than starting one immediately: the old behaviour
                  // always landed wherever the agent happened to be, which is the wrong
                  // project as often as the right one and was unfixable from the phone.
                  <CircleButton label="New conversation" onPress={onNewChat}>
                    <DotGlyph name="compose" size={16} />
                  </CircleButton>
                )}
                {!inThread && onHome && (
                  <CircleButton label="Back to home" onPress={onHome}>
                    <DotGlyph name="close" size={14} />
                  </CircleButton>
                )}
              </>
            )}
          </View>
        </View>
        {/* Not while a chat is reopening: that screen is Pew alone, centred,
          and the ticker fades in with the messages once they've loaded. */}
        {(inThread || daemon.restoreTarget) &&
          !(
            daemon.restoreTarget &&
            daemon.loadingSession &&
            (daemon.turns.length === 0 || holdingRestore)
          ) && (
            // Mounts with the transcript, so it dissolves in on the same beat.
            <Dissolve>
              <Ticker
                color={active?.color}
                working={daemon.busy && !daemon.loadingSession}
                activity={daemon.activity}
                needs={
                  daemon.permission ? daemon.permission.title : askHere ? "Question" : undefined
                }
                offline={daemon.status !== "online" || Boolean(daemon.unreachable)}
                project={daemon.workspace?.folder}
                changes={daemon.workspace?.uncommitted}
                say={kenSays?.text}
                onOpenChange={setStepsOpen}
                onOpenTools={onOpenTools}
              />
            </Dissolve>
          )}
        {/* A goal's crew: one slidable row of its workers under the ticker, each
          its own Pew in its role colour. Inside the measured overlay, so the
          thread starts below it. */}
        {inGoal && goalState && !daemon.restoreTarget && (
          <CrewRow workers={goalState.workers} hidden={stepsOpen} />
        )}
      </View>

      {/* Frosted cover for the nav zone only — it ends exactly at the nav's
          bottom edge and touches nothing below it. pointerEvents-none, so it
          never swallows a tap on a message or a pill. */}
      {navHeight > 0 && (
        <CanvasCover
          // From the very top edge to the nav's bottom edge. No tail.
          height={insets.top + navHeight}
          style={styles.navFade}
        />
      )}
    </>
  );
}

/**
 * Carry this conversation on at the desk: a `pew2 chat` window, or the agent's
 * own app. Only for a daemon that says it can (absent on older ones), in a
 * conversation, or on a new one once its project is known. Subtle by design: a
 * dim 16pt glyph, no glass, filled while pew2 has a window open for it.
 */
function DeskButton({
  daemon,
  inThread,
  active,
}: {
  daemon: ReturnType<typeof useDaemon>;
  inThread: boolean;
  active: Provider | undefined;
}) {
  const currentAgentSessionId = daemon.sessions.find(
    (session) => session.id === daemon.sessionId,
  )?.agentSessionId;
  const deskOpen = openWindows(daemon.desk, currentAgentSessionId, daemon.sessionId);
  // Android's alert holds three buttons; a longer menu is this small list.
  const [sheet, setSheet] = useState<DeskAction[] | undefined>(undefined);
  const shown =
    daemon.desk?.available &&
    (inThread ? !!daemon.sessionId : !daemon.sessionId && !!daemon.workspace?.cwd);
  if (!shown) return null;
  const open = (target: DeskTarget) => {
    const fresh = daemon.sessionId
      ? undefined
      : { providerId: daemon.effectiveProviderId, cwd: daemon.workspace?.cwd };
    void daemon.openOnComputer(target, fresh).then((result) => {
      if (result.ok && !result.message) return;
      Alert.alert(
        result.ok ? "Opened on the computer" : "Couldn't open it on the computer",
        result.message ?? "",
      );
    });
  };
  const close = () => {
    void daemon.closeOnComputer(currentAgentSessionId).then((result) => {
      if (!result.ok) Alert.alert("Couldn't close it on the computer", result.message ?? "");
    });
  };
  const actionLabel = (action: DeskAction) =>
    action.kind === "close"
      ? closeLabel(deskOpen, active?.name)
      : deskTargetLabel(action.target, active?.name);
  const run = (action: DeskAction) => (action.kind === "close" ? close() : open(action.target));
  const title = anyOpen(deskOpen) ? "On the computer" : "Open on the computer";
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open this conversation on the computer"
        hitSlop={12}
        style={({ pressed }) => [styles.deskButton, pressed && { opacity: 0.4 }]}
        onPress={() => {
          const actions = deskActions(
            daemon.desk,
            daemon.effectiveProviderId,
            currentAgentSessionId,
            daemon.sessionId,
          );
          const first = actions[0];
          if (actions.length === 1 && first?.kind === "open") {
            open(first.target);
            return;
          }
          if (needsSheet(actions, Platform.OS)) {
            setSheet(actions);
            return;
          }
          Alert.alert(title, undefined, [
            ...actions.map((action) => ({
              text: actionLabel(action),
              ...(action.kind === "close" && { style: "destructive" as const }),
              onPress: () => run(action),
            })),
            { text: "Cancel", style: "cancel" as const },
          ]);
        }}
      >
        <Ionicons
          name={anyOpen(deskOpen) ? "desktop" : "desktop-outline"}
          size={16}
          color={theme.color.textFaint}
        />
      </Pressable>
      <Modal
        visible={sheet !== undefined}
        transparent
        animationType="fade"
        onRequestClose={() => setSheet(undefined)}
      >
        <Pressable
          accessibilityLabel="Cancel"
          style={deskSheet.scrim}
          onPress={() => setSheet(undefined)}
        >
          <View style={deskSheet.card}>
            <Text style={deskSheet.title}>{title}</Text>
            {[
              ...(sheet ?? []).map((action) => ({ action, label: actionLabel(action) })),
              undefined,
            ].map((row) => (
              <Pressable
                key={row?.label ?? "cancel"}
                accessibilityRole="button"
                style={({ pressed }) => [deskSheet.row, pressed && deskSheet.pressed]}
                onPress={() => {
                  setSheet(undefined);
                  if (row) run(row.action);
                }}
              >
                <Text
                  style={[
                    deskSheet.label,
                    row?.action.kind === "close" && deskSheet.close,
                    !row && deskSheet.cancel,
                  ]}
                >
                  {row?.label ?? "Cancel"}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const deskSheet = {
  scrim: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    padding: 32,
  },
  card: {
    alignSelf: "stretch",
    backgroundColor: theme.color.surfaceRaised,
    borderRadius: 16,
    paddingVertical: 8,
  },
  title: {
    color: theme.color.text,
    fontSize: 17,
    fontWeight: "600",
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  row: { paddingHorizontal: 20, paddingVertical: 14 },
  pressed: { backgroundColor: theme.color.surfacePressed },
  label: { color: theme.color.accent, fontSize: 16 },
  close: { color: theme.color.danger },
  cancel: { color: theme.color.textDim },
} as const;
const titleBox = { flex: 1, minWidth: 0, justifyContent: "center" } as const;
const titleText = { flex: 0, alignSelf: "stretch" } as const;
