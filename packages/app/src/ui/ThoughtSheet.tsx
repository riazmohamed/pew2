/**
 * An agent's thinking, on demand.
 *
 * Reasoning is context, not the answer: printed inline it doubles the length of
 * every turn and buries the reply the user actually came for. So the transcript
 * shows one quiet "Thought process" row and the text lives here, in the same
 * card the command picker uses — same height, same chrome — scrolled rather
 * than truncated, because a thought worth opening is worth reading in full.
 */
import { memo, useRef } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { MarkdownText } from "./MarkdownText";
import { theme } from "../theme";
import { Sheet, sheetCardStyle, useSheetCardHeight } from "./Sheet";

interface ThoughtSheetProps {
  visible: boolean;
  text: string;
  onClose: () => void;
}

function ThoughtSheetView({ visible, text, onClose }: ThoughtSheetProps) {
  // The closed state carries no text, so the card would empty on the first
  // frame of the exit and the sheet would slide away blank. Keep the last
  // thought until another one replaces it.
  const held = useRef(text);
  if (text) held.current = text;
  // Fixed for a given screen rather than hugging its text: a two-line thought
  // and a two-page one open the same object. It still answers to the screen's
  // shape, so the card does not outgrow a phone turned on its side.
  const cardHeight = useSheetCardHeight();

  return (
    <Sheet
      visible={visible}
      title="Thought process"
      onClose={onClose}
      dismissLabel="Close thought process"
    >
      <View style={styles.card}>
        <ScrollView style={{ height: cardHeight }} contentContainerStyle={styles.content}>
          {/* The dim thinking tone it had inline, so opening it does not promote
              reasoning to the same weight as the agent's answer. */}
          <MarkdownText text={held.current.trimEnd()} tone="thought" />
        </ScrollView>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  card: sheetCardStyle,
  content: { padding: theme.space(4) },
});

export const ThoughtSheet = memo(ThoughtSheetView);
