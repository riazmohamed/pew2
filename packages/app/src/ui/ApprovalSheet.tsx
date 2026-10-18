/**
 * The approval request. The reason this app exists.
 *
 * The same sheet the commands use, with one difference that matters: it cannot
 * be dismissed. There is no close button and the scrim is inert, because the
 * agent is blocked on this answer — a tap that closed it would leave a stalled
 * turn and no way back to the question.
 *
 * Rows rather than a pair of buttons in the dock: a long generated option name
 * wraps instead of squeezing the safe choice into an unreadable sliver, and the
 * destructive one is unambiguously labelled rather than distinguished by colour
 * alone.
 */
import { memo, useRef } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { Sheet, useSheetMaxContentHeight } from "./Sheet";
import { StageButton } from "./stage/StageButton";
import { isDenyApprovalOption, selectApprovalOptions } from "../approvalOptions";
import type { PermissionRequest } from "../useDaemon";

interface ApprovalSheetProps {
  /** The pending request, or undefined once it has been answered. */
  permission?: PermissionRequest;
  onAnswer: (requestId: string, optionId: string, deny: boolean) => void;
}

function ApprovalSheetView({ permission, onAnswer }: ApprovalSheetProps) {
  // Held after the answer so the sheet can animate out with its content intact
  // — clearing on the same frame would empty the card mid-travel.
  const shown = useLastDefined(permission);
  const options = shown ? selectApprovalOptions(shown.options) : [];
  // A long request plus four options is taller than a phone held sideways, and
  // this card is anchored to the bottom edge — so a screen too short to hold it
  // loses the *top*, which is the request being approved. Scrolling instead
  // keeps the question and every answer reachable in either orientation.
  const maxHeight = useSheetMaxContentHeight();

  // The first choice that isn't a refusal is the one most people want, so it
  // is the lit button; other allows are secondary and refusals are danger.
  const primaryId = options.find((o) => !isDenyApprovalOption(o))?.optionId;
  return (
    <Sheet visible={permission !== undefined} label="Permission" labelTone="attention" pewMood="talking" title="Approval needed">
      <ScrollView
        style={{ maxHeight }}
        contentContainerStyle={styles.body}
        accessibilityLiveRegion="assertive"
        // Nothing here is a feed, and this sheet cannot be dismissed: a card
        // that springs under the thumb would be promising a way out of it.
        bounces={false}
      >
        <Text style={styles.request}>{shown?.title ?? ""}</Text>
        <View style={styles.buttons}>
          {options.map((option) => {
            const deny = isDenyApprovalOption(option);
            // Capture the request id now: another connected client can answer
            // first and clear the pending permission out from under this row.
            const requestId = shown!.requestId;
            const primary = option.optionId === primaryId;
            return (
              <StageButton
                key={option.optionId}
                kind={deny ? "danger" : primary ? "primary" : "secondary"}
                compact={!primary}
                feel={deny ? "warned" : "sent"}
                label={option.name}
                onPress={() => onAnswer(requestId, option.optionId, deny)}
              />
            );
          })}
        </View>
      </ScrollView>
    </Sheet>
  );
}

/** The last non-undefined value, so an exit animation still has something to draw. */
function useLastDefined<T>(value: T | undefined): T | undefined {
  const held = useRef(value);
  if (value !== undefined) held.current = value;
  return held.current;
}

const styles = StyleSheet.create({
  body: { gap: theme.space(3), paddingBottom: theme.space(1) },
  // Full text, not an ellipsis: what is being approved is the whole decision,
  // and a truncated path is exactly the detail that makes it a safe one.
  request: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    lineHeight: 20,
  },
  buttons: { gap: theme.space(2), paddingBottom: theme.space(2) },
});

export const ApprovalSheet = memo(ApprovalSheetView);
