/**
 * The site the agent is running, on the phone.
 *
 * Two ways in, chosen by where the phone is. On the desktop's own Wi-Fi the
 * page opens live in the in-app browser, hot reload and all, at the address the
 * daemon reported. Anywhere else the daemon renders it with headless Chrome at
 * this phone's width and sends a picture, refreshed on demand or every few
 * seconds while the sheet is open. Both start from the same list: what is
 * listening on the desktop right now.
 */
import { memo, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as WebBrowser from "expo-web-browser";
import { theme } from "../theme";
import { previewImageKey, previewUrl, rankServers, type PreviewServer } from "../preview";
import { SHEET_ROW_HEIGHT, Sheet, sheetCardStyle, useSheetMaxContentHeight } from "./Sheet";
import { touchSlop } from "./controls";
import type { ImageEntry } from "../useDaemon";

/** A live page changes on every save; this is often enough to follow along. */
const AUTO_REFRESH_MS = 5_000;

interface PreviewSheetProps {
  visible: boolean;
  lanHosts: readonly string[];
  servers: readonly PreviewServer[];
  /** The image cache: a snapshot lands under `previewImageKey(port)`. */
  images: Record<string, ImageEntry>;
  onSnapshot: (port: number, width: number) => void;
  onClose: () => void;
}

function PreviewSheetView({
  visible,
  lanHosts,
  servers,
  images,
  onSnapshot,
  onClose,
}: PreviewSheetProps) {
  const { width } = useWindowDimensions();
  const maxHeight = useSheetMaxContentHeight();
  const ranked = rankServers(servers);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [auto, setAuto] = useState(false);
  // The rendered page's shape, read off the bytes once they arrive, so the
  // picture takes its own height and scrolls rather than being squashed.
  const [ratio, setRatio] = useState<number | undefined>(undefined);

  // Closing forgets the pick: a server chosen last time may be gone by the
  // next open, and the list is the right place to land.
  useEffect(() => {
    if (!visible) {
      setSelected(undefined);
      setAuto(false);
    }
  }, [visible]);

  // Auto-refresh only while the snapshot is on screen. `onSnapshot` itself
  // drops a request while one is still rendering, so a slow page never stacks
  // Chrome launches behind a fast timer.
  useEffect(() => {
    if (!visible || !auto || selected === undefined) return;
    const timer = setInterval(() => onSnapshot(selected, Math.round(width)), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [visible, auto, selected, width, onSnapshot]);

  const open = (port: number) => {
    const url = previewUrl(lanHosts, port);
    if (!url) return;
    // Same chrome as a link tapped in the transcript.
    void WebBrowser.openBrowserAsync(url, {
      toolbarColor: theme.color.surface,
      controlsColor: theme.color.accent,
    });
  };

  const snapshot = (port: number) => {
    setSelected(port);
    onSnapshot(port, Math.round(width));
  };

  const shot = selected !== undefined ? images[previewImageKey(selected)] : undefined;

  return (
    <Sheet
      visible={visible}
      title={selected === undefined ? "Preview" : `Preview :${selected}`}
      onClose={onClose}
      onBack={selected === undefined ? undefined : () => setSelected(undefined)}
      dismissLabel="Close preview"
    >
      <View style={styles.card}>
        {selected === undefined ? (
          <ScrollView style={{ maxHeight }}>
            {ranked.length === 0 && (
              <View style={styles.row}>
                <Text style={styles.description}>
                  Nothing is listening on your computer. Ask the agent to start the dev server.
                </Text>
              </View>
            )}
            {ranked.map((server, index) => (
              <View
                key={server.port}
                style={[styles.row, index < ranked.length - 1 && styles.rowDivided]}
              >
                <View style={styles.rowText}>
                  <Text style={styles.name} numberOfLines={1}>
                    :{server.port}
                  </Text>
                  <Text style={styles.description} numberOfLines={1}>
                    {server.process}
                  </Text>
                </View>
                {/* Live only when the desktop has a LAN address to name; the
                    snapshot works from anywhere the daemon does. */}
                {lanHosts.length > 0 && (
                  <Action
                    icon="globe-outline"
                    label="Open live"
                    accessibilityLabel={`Open port ${server.port} live in the browser`}
                    onPress={() => open(server.port)}
                  />
                )}
                <Action
                  icon="camera-outline"
                  label="Snapshot"
                  accessibilityLabel={`Render port ${server.port} as a picture`}
                  onPress={() => snapshot(server.port)}
                />
              </View>
            ))}
          </ScrollView>
        ) : (
          <View>
            <View style={[styles.row, styles.rowDivided]}>
              <View style={styles.rowText}>
                <Text style={styles.description}>Refresh every 5s</Text>
              </View>
              <Switch
                value={auto}
                onValueChange={setAuto}
                accessibilityLabel="Refresh the snapshot every five seconds"
              />
              <Action
                icon="refresh"
                label="Refresh"
                accessibilityLabel="Take a new snapshot"
                onPress={() => onSnapshot(selected, Math.round(width))}
              />
            </View>
            <ScrollView style={{ maxHeight: maxHeight - SHEET_ROW_HEIGHT }}>
              {shot?.status === "ready" ? (
                // A phone-width page is tall; shown at its own aspect and
                // scrolled, never squashed to fit.
                <Image
                  source={{ uri: shot.dataUri }}
                  style={{ width: "100%", aspectRatio: ratio ?? 0.5 }}
                  contentFit="contain"
                  contentPosition="top"
                  onLoad={(event) =>
                    setRatio(event.source.width / Math.max(1, event.source.height))
                  }
                  accessibilityLabel={`Snapshot of port ${selected}`}
                />
              ) : shot?.status === "error" ? (
                <View style={styles.row}>
                  <Text style={styles.description}>{shot.message}</Text>
                </View>
              ) : (
                <View style={[styles.row, styles.centered]}>
                  <ActivityIndicator color={theme.color.textDim} />
                  <Text style={styles.description}>Rendering on your computer…</Text>
                </View>
              )}
            </ScrollView>
          </View>
        )}
      </View>
    </Sheet>
  );
}

function Action({
  icon,
  label,
  accessibilityLabel,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
      hitSlop={touchSlop(theme.space(2))}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
    >
      <Ionicons name={icon} size={16} color={theme.color.text} />
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
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
  rowText: { flex: 1, minWidth: 0, gap: theme.space(0.5) },
  centered: { justifyContent: "center", paddingVertical: theme.space(6) },
  name: { color: theme.color.text, fontSize: theme.font.body, fontWeight: "600" },
  description: { color: theme.color.textDim, fontSize: theme.font.small },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1),
    paddingVertical: theme.space(1.5),
    paddingHorizontal: theme.space(2.5),
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfacePressed,
  },
  actionPressed: { opacity: 0.6 },
  actionLabel: { color: theme.color.text, fontSize: theme.font.small, fontWeight: "600" },
});

export const PreviewSheet = memo(PreviewSheetView);
