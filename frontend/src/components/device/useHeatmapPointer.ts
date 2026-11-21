import { useRef, useState } from 'react';
import type { View } from './heatmapCanvas';
import {
  cursorTarget,
  hoverTarget,
  isOverDrawn,
  sensorsInRect,
} from './heatmapChart';
import type { Scene } from './heatmapScene';
import type { ImageSize } from './planMeters';
import type { SensorHeatmapLocation } from './sensorHeatmapTypes';
import type { AreaRect } from './useHeatmapViewport';

/** The plan under the cursor: the position in meters and the heat there
 * (with the cursor, for the reference guides). */
export type CursorHover = {
  kind: 'cursor';
  meters: [number, number] | null;
  heat: number | null;
  cursor: [number, number];
};

/** What the cursor points at: a sensor (by its pos) - with the plan under
 * the cursor too, so the position still shows - else only the plan. */
export type Hover =
  | {
      kind: 'sensor';
      pos: number;
      screen: [number, number];
      meters: [number, number] | null;
      under: CursorHover | null;
    }
  | CursorHover;

/** The drawn plot the pointer is over (the plan's alignment for meters). */
export type PlotContext = {
  scene: Scene;
  view: View;
  location: SensorHeatmapLocation | null;
  imageSize: ImageSize | null;
};

/** What the screen point (sx, sy) points at, and the device of a sensor
 * there (null off the sensors). */
export const hoverAt = (
  { scene, view, location, imageSize }: PlotContext,
  sx: number,
  sy: number,
): { hover: Hover | null; device: number | null } => {
  const { layout, frame } = scene;
  const target = hoverTarget(layout, frame, view, location, imageSize, sx, sy);
  if (target?.kind !== 'sensor') {
    return {
      hover: target ? { ...target, cursor: [sx, sy] } : null,
      device: null,
    };
  }
  const sensor = layout.sensors[target.index];
  const under = cursorTarget(layout, frame, view, location, sx, sy);
  return {
    hover: {
      kind: 'sensor',
      pos: sensor.pos,
      screen: target.screen,
      meters: target.meters,
      under: under ? { ...under, cursor: [sx, sy] } : null,
    },
    device: sensor.device,
  };
};

/** The pos (sensor_order) of the sensor at the screen point; null for none. */
export const sensorPosAt = (
  { scene, view, location, imageSize }: PlotContext,
  sx: number,
  sy: number,
) => {
  const target = hoverTarget(
    scene.layout,
    scene.frame,
    view,
    location,
    imageSize,
    sx,
    sy,
  );
  return target?.kind === 'sensor'
    ? scene.layout.sensors[target.index].pos
    : null;
};

/** The pos of the sensors in a dragged rectangle (screen pixels). */
export const sensorPositionsIn = (
  { scene, view }: PlotContext,
  rect: AreaRect,
) =>
  sensorsInRect(scene.layout, view, rect).map(
    (index) => scene.layout.sensors[index].pos,
  );

/** The pos of the hovered sensor; null off the sensors. */
export const hoveredPosition = (hover: Hover | null) =>
  hover?.kind === 'sensor' ? hover.pos : null;

/** The plan under the cursor - also while it is over a sensor. */
export const underCursorOf = (hover: Hover | null) =>
  hover?.kind === 'sensor' ? hover.under : hover;

/** The cursor the reference point's guides lead to - only to a position in meters. */
export const guideCursorOf = (hover: Hover | null) => {
  const under = underCursorOf(hover);
  return under?.meters ? under.cursor : null;
};

/**
 * The pointer over SensorHeatmap2D's plot - the callbacks for
 * usePanZoomGestures: what it points at (`hover`; the hovered sensor's
 * device goes to `onHoverDevice`, changes only - pointer moves are many), a
 * tap on a sensor (`onSensorClick`), where the wheel zooms (on the drawn
 * plan) and - with `onAreaSelect` - the area selection (`areaRect` while
 * dragging; a drag selects in `areaMode` or with Shift).
 */
export const useHeatmapPointer = ({
  scene,
  view,
  location,
  imageSize,
  onHoverDevice,
  onSensorClick,
  onAreaSelect,
  areaMode,
}: {
  scene: Scene | null;
  view: View | null;
  location: SensorHeatmapLocation | null;
  imageSize: ImageSize | null;
  onHoverDevice: ((device: number | null) => void) | undefined;
  onSensorClick: ((pos: number) => void) | undefined;
  onAreaSelect: ((positions: number[]) => void) | undefined;
  areaMode: boolean;
}) => {
  const [hover, setHover] = useState<Hover | null>(null);
  const [areaRect, setAreaRect] = useState<AreaRect | null>(null);
  // The device last reported to onHoverDevice.
  const reportedDevice = useRef<number | null>(null);
  const reportHoveredDevice = (device: number | null) => {
    if (reportedDevice.current !== device) {
      reportedDevice.current = device;
      onHoverDevice?.(device);
    }
  };
  const plot: PlotContext | null =
    scene && view ? { scene, view, location, imageSize } : null;

  const onHover = (sx: number, sy: number) => {
    if (!plot) {
      return;
    }
    const next = hoverAt(plot, sx, sy);
    reportHoveredDevice(next.device);
    setHover(next.hover);
  };

  const onLeave = () => {
    setHover(null);
    reportHoveredDevice(null);
  };

  const onTap = (sx: number, sy: number) => {
    const pos = plot && onSensorClick ? sensorPosAt(plot, sx, sy) : null;
    if (pos != null) {
      onSensorClick?.(pos);
    }
  };

  // Only over the drawn plan the wheel zooms instead of scrolling the page.
  const wheelZoomsAt = (sx: number, sy: number) =>
    Boolean(
      plot &&
      isOverDrawn(plot.scene.layout, plot.view, imageSize != null, sx, sy),
    );

  const area = onAreaSelect
    ? {
        starts: (event: { shiftKey: boolean }) => areaMode || event.shiftKey,
        onChange: setAreaRect,
        onSelect: (rect: AreaRect) => {
          if (plot) {
            onAreaSelect(sensorPositionsIn(plot, rect));
          }
        },
      }
    : undefined;

  return {
    hover,
    areaRect,
    gestures: { onHover, onLeave, onTap, wheelZoomsAt, area },
  };
};
