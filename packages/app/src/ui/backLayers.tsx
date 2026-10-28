/**
 * Android back for overlays drawn inside the screen (sheets), which a native
 * `Modal` would get for free. A sheet registers while it is up; the screen's
 * one back handler asks for the top one (`callMinimise.backAction`).
 */
import { createContext, useContext, useEffect, useMemo, useRef } from "react";

export interface BackLayer {
  /** Absent: the layer cannot be closed (a blocking approval), so back stays. */
  close?: () => void;
}

export interface BackLayers {
  add(layer: { current: BackLayer }): () => void;
  top(): BackLayer | undefined;
}

const BackLayerContext = createContext<BackLayers | undefined>(undefined);
export const BackLayerProvider = BackLayerContext.Provider;

/** The screen's registry, one per mounted screen. */
export function useBackLayers(): BackLayers {
  const stack = useRef<{ current: BackLayer }[]>([]);
  return useMemo(
    () => ({
      add(layer) {
        stack.current = [...stack.current, layer];
        return () => {
          stack.current = stack.current.filter((entry) => entry !== layer);
        };
      },
      top() {
        return stack.current[stack.current.length - 1]?.current;
      },
    }),
    [],
  );
}

/** Register an overlay for Android back while `visible`. */
export function useBackLayer(visible: boolean, close: (() => void) | undefined): void {
  const layers = useContext(BackLayerContext);
  const layer = useRef<BackLayer>({ close });
  layer.current = { close };
  useEffect(() => {
    if (!visible || !layers) return;
    return layers.add(layer);
  }, [visible, layers]);
}
