import { Alert, Pressable, StyleSheet, Switch, Text, View, useWindowDimensions } from "react-native";
import { StageScroll } from "./stage/StageScroll";
import { Sheet } from "./Sheet";
import { PrivacyLink } from "./PrivacyLink";
import { haptics } from "./haptics";
import { Handshake, type HandshakePhase } from "./Handshake";
import { Led } from "./stage/Led";
import { DashedRule } from "./stage/DashedRule";
import { Dissolve } from "./motion/Dissolve";
import { theme } from "../theme";
import type { Status } from "../useDaemon";
import { AGENTS_NOTE, agentNote, agentRows, type CatalogEntry } from "../agentSettings";

// Same fixed desktop install/update instruction formerly shown in Sidebar.
const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/KenKaiii/pew2/main/install.sh | sh";
/** Shared label column, so every value starts at the same x. */
const LABEL_WIDTH = 92;

interface Props {
  visible: boolean;
  machineLabel: string;
  machineRemote: boolean;
  status: Status;
  update?: { latest: string; automatic: boolean };
  /** Absent = a daemon older than keep-awake: no row at all. */
  keepAwake?: { supported: boolean; enabled: boolean; active: boolean; reason?: string };
  onKeepAwake?: (enabled: boolean) => void;
  /** Every agent the computer knows. Absent = older daemon: no Agents section. */
  catalog?: CatalogEntry[];
  onToggleAgent?: (id: string, enabled: boolean) => void;
  onClose: () => void;
  onUnpair: () => void;
}

const PHASE = { online: "paired", connecting: "pairing", offline: "waiting" } satisfies Record<Status, HandshakePhase>;

function Row({ label, index, children }: { label: string; index: number; children: React.ReactNode }) {
  return (
    <Dissolve kind="row" delay={index * 50}>
      <View style={styles.row}>
        <Led tone="dim" style={styles.rowLabel}>{label}</Led>
        <View style={styles.rowValue}>{children}</View>
      </View>
    </Dissolve>
  );
}

export function ConnectionSheet({ visible, machineLabel, machineRemote, status, update, keepAwake, onKeepAwake, catalog, onToggleAgent, onClose, onUnpair }: Props) {
  const agents = agentRows(catalog);
  const { height: screenHeight } = useWindowDimensions();
  const title = status === "online" ? "Connected" : status === "connecting" ? "Connecting…" : "Offline";
  return <Sheet visible={visible} label="Connection" labelTone={status === "connecting" ? "attention" : "agent"} pewMood={status === "online" ? "happy" : status === "connecting" ? "thinking" : "sleepy"} title={title} onClose={onClose} dismissLabel="Close connection details">
    <StageScroll style={[styles.scroll, { maxHeight: Math.round(screenHeight * 0.75) }]} contentContainerStyle={styles.content}>
      <Handshake phase={PHASE[status]} />
      <DashedRule />
      <Row label="Computer" index={0}>
        {/* The computer's own name, never the relay's address. */}
        <Text selectable numberOfLines={1} style={styles.value}>{machineLabel}</Text>
      </Row>
      <Row label="Route" index={1}>
        <Text numberOfLines={1} style={styles.value}>{machineRemote ? "Relay, sealed end to end" : "Same network"}</Text>
      </Row>
      {update && <Row label="pew2" index={2}>
        {update.automatic ? <Text numberOfLines={1} style={styles.value}>Updating to {update.latest}…</Text> :
          <Pressable accessibilityRole="button" accessibilityLabel={`pew2 ${update.latest} is available for ${machineLabel}. How to update.`} hitSlop={8} onPress={() => {
            haptics.tap();
            Alert.alert(`pew2 ${update.latest} is available`, `This computer can't update itself, so run this on ${machineLabel}:\n\n${INSTALL_COMMAND}`, [{ text: "OK" }]);
          }}><Text numberOfLines={1} style={[styles.value, styles.link]}>{update.latest} available · How</Text></Pressable>}
      </Row>}
      {keepAwake && <Row label="Awake" index={3}>
        <View style={styles.awake}>
          <Text style={styles.awakeText} numberOfLines={2}>{!keepAwake.supported ? (keepAwake.reason ?? "Not supported on this computer.")
            : !keepAwake.enabled ? "Sleeps on its normal schedule."
            : keepAwake.active ? "Awake now: an agent is working or you're connected."
            : "Can still sleep when nothing's happening."}</Text>
          <Switch value={keepAwake.supported && keepAwake.enabled} disabled={!keepAwake.supported || status !== "online"} accessibilityLabel="Keep computer awake while in use" onValueChange={(enabled) => { haptics.tap(); onKeepAwake?.(enabled); }} />
        </View>
      </Row>}
      {agents.length > 0 && <>
        <DashedRule />
        <Led tone="dim">Agents</Led>
        <Text style={styles.agentsNote}>{AGENTS_NOTE}</Text>
        {agents.map((agent) => {
          const note = agentNote(agent);
          return (
            <View key={agent.id} style={styles.agentRow}>
              <View style={styles.agentText}>
                <Text style={[styles.agentName, !agent.installed && styles.agentAbsent]} numberOfLines={1}>{agent.name}</Text>
                {note && <Text style={styles.agentsNote} numberOfLines={1}>{note}</Text>}
              </View>
              <Switch
                value={agent.enabled}
                disabled={status !== "online"}
                accessibilityLabel={`${agent.name}${note ? `. ${note}` : ""}`}
                onValueChange={(enabled) => { haptics.tap(); onToggleAgent?.(agent.id, enabled); }}
              />
            </View>
          );
        })}
      </>}
      <DashedRule />
      <PrivacyLink />
      <Pressable accessibilityRole="button" accessibilityLabel={`Forget pairing with ${machineLabel}`} style={styles.action} onPress={() => {
        haptics.warned();
        Alert.alert("Forget this computer?", "You'll need to scan or paste its pairing link to connect again.", [
          { text: "Cancel", style: "cancel" },
          { text: "Forget", style: "destructive", onPress: () => { haptics.warned(); onUnpair(); } },
        ]);
      }}><Text style={styles.destructive}>Unpair this computer</Text></Pressable>
    </StageScroll>
  </Sheet>;
}
const styles = StyleSheet.create({
  // Everything shows at once (it is short); only a very small screen scrolls.
  scroll: { flexGrow: 0 },
  content: { paddingBottom: theme.sectionGap, gap: theme.space(3) },
  row: { flexDirection: "row", alignItems: "center", minHeight: theme.size.touch },
  rowLabel: { width: LABEL_WIDTH },
  rowValue: { flex: 1, alignItems: "flex-end" },
  value: { color: theme.color.text, fontSize: theme.font.body, lineHeight: theme.line.body, textAlign: "right" },
  agentRow: { flexDirection: "row", alignItems: "center", gap: theme.space(3), minHeight: theme.size.touch },
  agentText: { flex: 1, minWidth: 0 },
  agentName: { color: theme.color.text, fontSize: theme.font.body, lineHeight: theme.line.body },
  agentAbsent: { color: theme.color.textDim },
  agentsNote: { color: theme.color.textDim, fontSize: theme.font.small, lineHeight: 18 },
  awake: { flexDirection: "row", alignItems: "center", gap: theme.space(3) },
  awakeText: { flexShrink: 1, color: theme.color.textDim, fontSize: theme.font.small, lineHeight: 18, textAlign: "right" },
  link: { color: theme.color.accent },
  action: { minHeight: theme.size.touch, justifyContent: "center" },
  destructive: { color: theme.color.danger, fontSize: theme.font.body, lineHeight: 20 },
});
