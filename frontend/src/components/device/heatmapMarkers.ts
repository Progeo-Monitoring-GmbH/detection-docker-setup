import type { ChartSensor } from './heatmapChart';
import type { AreaRect } from './useHeatmapViewport';

/**
 * Which of SensorHeatmap2D's sensor markers stand out (hovered, highlighted
 * from outside, selected, focused) and what the pointer over the plan looks
 * like - as indices into the layout's sensors, for drawScene.
 */

const indexOf = (
  sensors: ChartSensor[] | undefined,
  match: (sensor: ChartSensor) => boolean,
) => {
  const index = sensors?.findIndex(match) ?? -1;
  return index >= 0 ? index : null;
};

/** The sensor with this pos (sensor_order); null for none / no pos. */
export const positionIndex = (
  sensors: ChartSensor[] | undefined,
  pos: number | null,
) => (pos != null ? indexOf(sensors, (sensor) => sensor.pos === pos) : null);

/** The sensor highlighted from outside: by its device, else by its pos. */
export const highlightIndex = (
  sensors: ChartSensor[] | undefined,
  device: number | null,
  pos: number | null,
) =>
  device != null
    ? indexOf(sensors, (sensor) => sensor.device === device)
    : positionIndex(sensors, pos);

/** The indices of the sensors with one of these pos. */
export const selectedIndexSet = (
  sensors: ChartSensor[] | undefined,
  positions: number[] | undefined,
) => {
  const wanted = new Set(positions ?? []);
  return new Set(
    (sensors ?? []).flatMap((sensor, index) =>
      wanted.has(sensor.pos) ? [index] : [],
    ),
  );
};

/** The markers drawn apart, besides the selection (memoized by the caller). */
export const markerIndices = (
  sensors: ChartSensor[] | undefined,
  {
    hoveredPosition,
    highlightedDevice,
    highlightedPosition,
    focusedPosition,
  }: {
    hoveredPosition: number | null;
    highlightedDevice: number | null;
    highlightedPosition: number | null;
    focusedPosition: number | null;
  },
) => ({
  hovered: positionIndex(sensors, hoveredPosition),
  highlighted: highlightIndex(sensors, highlightedDevice, highlightedPosition),
  focused: positionIndex(sensors, focusedPosition),
});

export type CanvasCursor = 'crosshair' | 'pointer' | 'grabbing' | 'grab';

/** The pointer over the plan: selecting an area, over a sensor, panning. */
export const canvasCursor = ({
  areaMode,
  overSensor,
  grabbing,
}: {
  areaMode: boolean;
  overSensor: boolean;
  grabbing: boolean;
}): CanvasCursor => {
  if (areaMode) {
    return 'crosshair';
  }
  if (overSensor) {
    return 'pointer';
  }
  return grabbing ? 'grabbing' : 'grab';
};

/** The box (screen pixels) of a dragged rectangle, from any corner. */
export const areaRectBox = ([x0, y0, x1, y1]: AreaRect) => ({
  left: Math.min(x0, x1),
  top: Math.min(y0, y1),
  width: Math.abs(x1 - x0),
  height: Math.abs(y1 - y0),
});
