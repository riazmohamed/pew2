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
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { Sheet, useSheetMaxContentHeight } from "./Sheet";
import { StageButton } from "./stage/StageButton";
import { isDenyApprovalOption, selectApprovalOptions } from "../approvalOptions";
import type { PermissionRequest } from "../useDaemon";

interface ApprovalSheetProps {
  /** The pending request, or undefined once it has been answered. */
  permission?: PermissionRequest;
  onAnswer: (requestId: string, optionId: string, deny: boolean) => void;
  /** "Talk it through": start a call focused on this request. Absent without voice. */
  onTalk?: (requestId: string) => void;
  /**
   * Shown on a call: the same card, read out by Pew. `from` names the session
   * asking, `voicePick` is the option Pew is choosing (lit as it goes), and the
   * card can be put away for the call, which an approval otherwise can't.
   */
  call?: { from: string; voicePick?: string; onHide: () => void };
}

function ApprovalSheetView({ permission, onAnswer, onTalk, call }: ApprovalSheetProps) {
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
  // While Pew is choosing by voice, its choice is the big one: lit if it is an
  // allow, full-size danger if it is a refusal (a refusal is never lit).
  const picked = call?.voicePick ? options.find((o) => o.optionId === call.voicePick) : undefined;
  const primaryId = picked
    ? isDenyApprovalOption(picked)
      ? undefined
      : picked.optionId
    : options.find((o) => !isDenyApprovalOption(o))?.optionId;
  return (
    <Sheet
      visible={permission !== undefined}
      label={call ? `Permission · ${call.from}` : "Permission"}
      labelTone="attention"
      pewMood="talking"
      title="Approval needed"
      onClose={call?.onHide}
      dismissLabel={call ? "Hide this request" : undefined}
    >
      <ScrollView
        style={{ maxHeight }}
        contentContainerStyle={styles.body}
        accessibilityLiveRegion="assertive"
        // Nothing here is a feed: a card that springs under the thumb would
        // be promising a way out the buttons do not offer.
        bounces={false}
      >
        <Text style={styles.request}>{shown?.title ?? ""}</Text>
        {shown?.details ? (
          <Text style={styles.details} selectable>
            {shown.details}
          </Text>
        ) : null}
        <View style={styles.buttons}>
          {options.map((option) => {
            const deny = isDenyApprovalOption(option);
            // Capture the request id now: another connected client can answer
            // first and clear the pending permission out from under this row.
            const requestId = shown!.requestId;
            const primary = option.optionId === primaryId;
            const big = primary || option.optionId === picked?.optionId;
            return (
              <StageButton
                key={option.optionId}
                kind={deny ? "danger" : primary ? "primary" : "secondary"}
                compact={!big}
                feel={deny ? "warned" : "sent"}
                label={option.name}
                onPress={() => onAnswer(requestId, option.optionId, deny)}
              />
            );
          })}
          {onTalk && shown && (
            <StageButton
              compact
              kind="secondary"
              feel="tap"
              label="Talk it through"
              onPress={() => onTalk(shown.requestId)}
            />
          )}
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
  // Body colour, not dim: this is the thing being decided.
  request: {
    color: theme.color.text,
    fontSize: theme.font.body,
    lineHeight: 22,
  },
  // The command, path or diff, monospaced so a diff lines up.
  details: {
    color: theme.color.text,
    fontSize: theme.font.small,
    lineHeight: 18,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
  },
  buttons: { gap: theme.space(2), paddingBottom: theme.space(2) },
});

export const ApprovalSheet = memo(ApprovalSheetView);
