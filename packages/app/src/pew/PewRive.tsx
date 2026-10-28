/**
 * Pew drawn from the Rive file (assets/rive/pew.riv) instead of Skia.
 *
 * Contract with the file: artboard `Pew`, state machine `Pew`, view model
 * `Pew` (default instance) with `mood` (number, see riveMood), `color`
 * (colour) and `level` (0..1, unused here). The file is bound once and the
 * two properties are set on its instance; the state machine does the rest.
 *
 * Fail safe: if the runtime, the file or the view model fails, this renders
 * FlatPew in the same box and logs once. Never a blank, never a crash.
 */
import { Component, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import {
  Fit,
  RiveColor,
  RiveView,
  useRiveFile,
  useViewModelInstance,
  type RiveViewRef,
} from "@rive-app/react-native";
import type { PewMood } from "./engineBody";
import { FlatPew } from "./FlatPew";
import { pewPalette } from "./palette";
import { riveMood } from "./riveFlag";
import { useAppActive } from "../ui/useAppActive";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PEW_RIV: number = require("../../assets/rive/pew.riv");

/** Logged once per app run, however many Pews fall back. */
const logged = { done: false };
function logOnce(why: string): void {
  if (logged.done) return;
  logged.done = true;
  console.warn(`PewRive: falling back to FlatPew (${why})`);
}

export interface PewRiveProps {
  size: number;
  mood: PewMood;
  color?: string;
  paused?: boolean;
}

function Fallback({ size, mood, color, paused }: PewRiveProps) {
  const palette = useMemo(() => pewPalette(color), [color]);
  const appActive = useAppActive();
  return (
    <FlatPew size={size} mood={mood} palette={palette} still={!appActive || paused === true} />
  );
}

function RivePew({
  size,
  mood,
  color,
  paused,
  onFail,
}: PewRiveProps & { onFail: (why: string) => void }) {
  const { riveFile, error } = useRiveFile(PEW_RIV);
  const { instance, error: vmError } = useViewModelInstance(riveFile, { async: true });
  const ref = useRef<RiveViewRef | null>(null);
  const appActive = useAppActive();
  const running = appActive && paused !== true;
  const rgb = useMemo(() => pewPalette(color).base, [color]);

  useEffect(() => {
    if (error) onFail(`file: ${error.message}`);
    else if (vmError) onFail(`view model: ${vmError.message}`);
    else if (riveFile && instance === null) onFail("no view model");
  }, [error, vmError, riveFile, instance, onFail]);

  useEffect(() => {
    if (!instance) return;
    try {
      instance.numberProperty("mood")?.set(riveMood(mood));
      instance.colorProperty("color")?.set(new RiveColor(rgb[0], rgb[1], rgb[2], 255).toInt());
      if (running) ref.current?.playIfNeeded();
    } catch (e) {
      onFail(`set: ${String(e)}`);
    }
  }, [instance, mood, rgb, running, onFail]);

  useEffect(() => {
    const view = ref.current;
    if (!view) return;
    const step = running ? view.play() : view.pause();
    step.catch(() => undefined);
  }, [running, instance]);

  if (!riveFile || !instance) {
    // Loading: the flat Pew holds the box so nothing jumps or flashes blank.
    return <Fallback size={size} mood={mood} color={color} paused />;
  }
  return (
    <RiveView
      hybridRef={{ f: (r) => (ref.current = r) }}
      file={riveFile}
      artboardName="Pew"
      stateMachineName="Pew"
      dataBind={instance}
      autoPlay={running}
      frameRate={30}
      fit={Fit.Contain}
      style={{ width: size, height: size, backgroundColor: "transparent" }}
      onError={(e) => onFail(`view: ${e.message}`)}
    />
  );
}

/** Catches a throw from the native view or the hooks; renders the fallback. */
class Guard extends Component<
  { fallback: ReactNode; onFail: (why: string) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(e: unknown): void {
    this.props.onFail(`threw: ${String(e)}`);
  }
  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function PewRiveView(props: PewRiveProps) {
  const [failed, setFailed] = useState(false);
  const onFail = useMemo(
    () => (why: string) => {
      logOnce(why);
      setFailed(true);
    },
    [],
  );
  const fallback = <Fallback {...props} />;
  return (
    <View
      style={{ width: props.size, height: props.size, backgroundColor: "transparent" }}
      pointerEvents="none"
    >
      {failed ? (
        fallback
      ) : (
        <Guard fallback={fallback} onFail={onFail}>
          <RivePew {...props} onFail={onFail} />
        </Guard>
      )}
    </View>
  );
}

export const PewRive = memo(PewRiveView);
