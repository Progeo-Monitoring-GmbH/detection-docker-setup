import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ChartFrame } from './heatmapChart';
import type { View } from './heatmapCanvas';
import {
  drawScene,
  renderSceneFrame,
  sizedContext,
  type Scene,
  type SceneOverlay,
} from './heatmapScene';
import { markerIndices, selectedIndexSet } from './heatmapMarkers';
import { useHeatmapFrameExport } from './useHeatmapFrameExport';
import {
  guideCursorOf,
  hoveredPosition,
  type Hover,
} from './useHeatmapPointer';

/**
 * What is drawn over the scene: the hovered sensor, the one highlighted from
 * outside (by device, else by pos), the selected ones (a lila ring), the
 * focused one (a white ring) and the cursor the reference guides lead to.
 */
export const useSceneOverlay = (
  scene: Scene | null,
  hover: Hover | null,
  {
    highlightedDevice,
    highlightedPosition,
    selectedPositions,
    focusedPosition,
  }: {
    highlightedDevice: number | null;
    highlightedPosition: number | null;
    selectedPositions: number[] | undefined;
    focusedPosition: number | null;
  },
) => {
  const sensors = scene?.layout.sensors;
  const selected = useMemo(
    () => selectedIndexSet(sensors, selectedPositions),
    [sensors, selectedPositions],
  );
  const { hovered, highlighted, focused } = markerIndices(sensors, {
    hoveredPosition: hoveredPosition(hover),
    highlightedDevice,
    highlightedPosition,
    focusedPosition,
  });
  return {
    hovered,
    highlighted,
    selected,
    focused,
    cursor: guideCursorOf(hover),
  };
};

/**
 * Draws the scene onto the canvas (at the device pixel ratio) whenever it,
 * the view, the size or the overlay (hovered / highlighted / selected /
 * focused markers, the guides' cursor) change. The overlay's parts are the
 * effect's dependencies, so a new overlay object alone doesn't redraw.
 */
export const useDrawnScene = (
  canvasRef: RefObject<HTMLCanvasElement | null>,
  scene: Scene | null,
  view: View | null,
  width: number,
  height: number,
  { hovered, highlighted, selected, focused, cursor }: SceneOverlay,
) => {
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !scene || !view || width <= 0) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const ctx = sizedContext(canvas, width, height, dpr);
    if (ctx) {
      drawScene(
        ctx,
        scene,
        { width, height, dpr },
        view,
        { hovered, highlighted, selected, focused, cursor },
        null,
      );
    }
  }, [
    canvasRef,
    scene,
    view,
    width,
    height,
    hovered,
    highlighted,
    selected,
    focused,
    cursor,
  ]);
};

/**
 * The video export of the heatmap (useHeatmapFrameExport) with its frames
 * drawn from the scene in the current view (renderSceneFrame). The export
 * loop keeps the functions it started with: it must still draw the frame the
 * slider shows now, so they go through a ref; it waits for each frame to be
 * drawn (`frame` changing).
 */
export const useSceneVideoExport = ({
  scene,
  frame,
  view,
  width,
  height,
  timestamps,
  frameIndex,
  setFrameIndex,
}: {
  scene: Scene | null;
  frame: ChartFrame | null;
  view: View | null;
  width: number;
  height: number;
  timestamps: number[];
  frameIndex: number;
  setFrameIndex: (index: number) => void;
}) => {
  const exportRef = useRef<{
    renderFrame: (width: number, height: number) => HTMLCanvasElement | null;
    afterDraw: (() => void) | null;
  }>({ renderFrame: () => null, afterDraw: null });
  const captureFrame = useCallback(
    (frameWidth: number, frameHeight: number) =>
      exportRef.current.renderFrame(frameWidth, frameHeight),
    [],
  );
  const frameSize = useCallback(
    () => (width > 0 ? { width, height } : null),
    [width, height],
  );

  const videoExport = useHeatmapFrameExport({
    captureFrame,
    frameSize,
    chartReady: scene != null,
    timestamps,
    timestampIndex: frameIndex,
    setTimestampIndex: setFrameIndex,
  });

  useLayoutEffect(() => {
    exportRef.current = {
      renderFrame: (frameWidth, frameHeight) =>
        scene && view && width > 0
          ? renderSceneFrame(
              scene,
              view,
              { width, height },
              frameWidth,
              frameHeight,
            )
          : null,
      afterDraw: videoExport.handleAfterPlot,
    };
  });
  useEffect(() => {
    exportRef.current.afterDraw?.();
  }, [frame]);

  return videoExport;
};

/**
 * The height of the last plot shown (while `shown`): the placeholder keeps
 * it while a plan image loads, so switching plans doesn't make the page jump.
 * Before any plot: `height` itself.
 */
export const useHeldHeight = (shown: boolean, height: number) => {
  const [held, setHeld] = useState<number | null>(null);
  if (shown && held !== height) {
    setHeld(height);
  }
  return held ?? height;
};
