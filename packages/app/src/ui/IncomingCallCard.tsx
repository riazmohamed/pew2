/** Pew ringing, on a phone the system cannot ring (Android): answer or decline. */
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import type { IncomingRing } from "../androidRing";
import { Sheet } from "./Sheet";
import { StageButton } from "./stage/StageButton";

interface Props {
  ring: IncomingRing | undefined;
  onAnswer: () => void;
  onDecline: () => void;
}

export function IncomingCallCard({ ring, onAnswer, onDecline }: Props) {
  return (
    <Sheet visible={ring !== undefined} label="Incoming call" pewMood="talking" title={ring?.caller ?? "Pew"} onClose={onDecline} dismissLabel="Decline">
      <View style={styles.content} accessibilityLiveRegion="assertive">
        <Text style={styles.line}>{ring?.body ?? ""}</Text>
        <StageButton label="Answer" feel="chosen" onPress={onAnswer} />
        <StageButton kind="danger" label="Decline" feel="warned" onPress={onDecline} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: { gap: theme.space(3), paddingBottom: theme.sectionGap },
  line: { color: theme.color.text, fontSize: theme.font.body, lineHeight: 20 },
});
