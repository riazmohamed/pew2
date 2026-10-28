/**
 * Pew in Calm mode: a pulse line instead of the 3D ball (28 Oct: "make it
 * like an ECG, voice streaming type animations rather than fancy animation").
 *
 * A row of rounded bars in plain Views. Working or thinking, a heartbeat blip
 * crosses it; talking or listening, the bars rise and fall like speech levels;
 * otherwise it rests as a flat trace with one small beat. Only `scaleY`
 * transforms move, on the UI thread, from one shared clock: no canvas, no
 * layout, nothing per frame on the JS thread. It stops when nobody can see it
 * (paused, app in the background) and for the OS Reduce Motion setting.
 */
import { memo, useCallback, useEffect } from "react";
import { View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type FrameInfo,
  type SharedValue,
} from "react-native-reanimated";
import type { PewMood, PewPalette, RGB } from "./engineBody";
import { pulseBars, pulseFrame, pulseKind, pulsePeriod, type PulseKind } from "./pulseShape";

/** Clock steps per second. */
const FPS = 24;

const rgb = (c: RGB, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

function Dot({
  index,
  count,
  kind,
  clock,
  dot,
  amp,
  color,
}: {
  index: number;
  count: number;
  kind: PulseKind;
  clock: SharedValue<number>;
  /** Dot diameter. */
  dot: number;
  /** Pixels for a lift of 1. */
  amp: number;
  color: string;
}) {
  const x = count > 1 ? index / (count - 1) : 0.5;
  const w = count > 1 ? 1 / (count - 1) : 0.2;
  const seed = (index * 0.37) % 1;
  const style = useAnimatedStyle(() => {
    const f = pulseFrame(kind, x, clock.value, w, seed);
    return {
      opacity: f.opacity,
      transform: [{ translateY: -f.lift * amp }, { scaleY: f.stretch }],
    };
  });
  return (
    <Animated.View
      style={[{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color }, style]}
    />
  );
}

function FlatPewView({
  size,
  mood,
  palette,
  still,
}: {
  size: number;
  mood: PewMood;
  palette: PewPalette;
  /** Hold the shape without motion (paused, backgrounded, OS Reduce Motion). */
  still: boolean;
}) {
  const kind = pulseKind(mood);
  const period = pulsePeriod(kind, mood);
  const moving = !still && kind !== "still";
  // The clock steps at most FPS times a second: every step restyles every
  // dot, and at the display's 120Hz a row of dots cost most of a core on the
  // OnePlus (28 Oct). 24 steps a second still reads as smooth for a trace.
  const clock = useSharedValue(0.5);
  const since = useSharedValue(0);
  const tick = useCallback(
    (info: FrameInfo) => {
      "worklet";
      since.value += info.timeSincePreviousFrame ?? 16;
      if (since.value < 1000 / FPS) return;
      clock.value = (clock.value + since.value / period) % 1;
      since.value = 0;
    },
    [clock, since, period],
  );
  const frames = useFrameCallback(tick, false);
  useEffect(() => {
    if (!moving) {
      frames.setActive(false);
      clock.value = 0.5;
      return;
    }
    clock.value = 0;
    frames.setActive(true);
    return () => frames.setActive(false);
  }, [moving, frames, clock]);

  const count = pulseBars(size);
  const span = size * 0.86;
  const pitch = span / count;
  const dot = Math.max(2, pitch * 0.62);
  const amp = size * 0.3;
  // The agent's own colour at full strength (`base`), so OG Coder, GG Goals
  // and Claude Code read apart at a glance.
  const color = rgb(mood === "oops" ? [255, 107, 96] : palette.base, mood === "sleepy" ? 0.55 : 1);
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: pitch - dot,
      }}
      pointerEvents="none"
    >
      {Array.from({ length: count }, (_, i) => (
        <Dot
          key={i}
          index={i}
          count={count}
          kind={kind}
          clock={clock}
          dot={dot}
          amp={amp}
          color={color}
        />
      ))}
    </View>
  );
}

export const FlatPew = memo(FlatPewView);
