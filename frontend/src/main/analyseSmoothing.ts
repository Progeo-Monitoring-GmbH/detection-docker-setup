import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import type { MeasurementCompareRow } from '../components/device/MeasurementSamplesCompareChart';
import { parseTimestamp } from './alarmUtils';

/**
 * The Analyse tab's noise filter: each value becomes the mean of `window`
 * neighbouring loaded measurements (centred on it, fewer at the ends) - the
 * finer the resolution, the closer they are in time. Missing values are
 * skipped and stay missing; window 1 leaves everything as it is.
 */

/** The offered windows (1: off). */
export const MEAN_WINDOWS = [1, 3, 5, 10, 20] as const;

/** `values` (one per measurement, in time order) as moving means over `window`. */
export const movingMean = (values: ReadonlyArray<number | null>, window: number): Array<number | null> => {
  if (window <= 1) {
    return [...values];
  }
  const before = Math.floor((window - 1) / 2);
  const after = window - 1 - before;
  return values.map((value, index) => {
    if (value == null || !Number.isFinite(value)) {
      return value;
    }
    let sum = 0;
    let count = 0;
    const last = Math.min(values.length - 1, index + after);
    for (let neighbour = Math.max(0, index - before); neighbour <= last; neighbour += 1) {
      const entry = values[neighbour];
      if (entry != null && Number.isFinite(entry)) {
        sum += entry;
        count += 1;
      }
    }
    return sum / count;
  });
};

/** The heatmap with every sensor's series smoothed (its frames unchanged). */
export const smoothHeatmap = (
  heatmap: SensorHeatmapResponse | null,
  window: number,
): SensorHeatmapResponse | null => {
  if (!heatmap || window <= 1) {
    return heatmap;
  }
  const data = Object.fromEntries(
    Object.entries(heatmap.data ?? {}).map(([sensor, values]) => [sensor, movingMean(values, window)]),
  );
  return { ...heatmap, data };
};

/** Column `position` of `rows`' arrays, null where a row has none. */
const columnOf = (arrays: ReadonlyArray<ReadonlyArray<number> | undefined>, position: number) =>
  arrays.map((array) => {
    const value = array?.[position];
    return value == null ? null : Number(value);
  });

/** Every column of the arrays smoothed over the rows; the rows keep their lengths. */
const smoothColumns = (arrays: ReadonlyArray<ReadonlyArray<number> | undefined>, window: number) => {
  const width = arrays.reduce((widest, array) => Math.max(widest, array?.length ?? 0), 0);
  const columns = Array.from({ length: width }, (_, position) => movingMean(columnOf(arrays, position), window));
  return arrays.map((array, row) =>
    array ? array.map((value, position) => columns[position][row] ?? value) : array,
  );
};

/**
 * The measurements with their samples (EP / WP of every sensor) and pair
 * values (|WP - EP|) smoothed over time; same rows, same order.
 */
export const smoothMeasurements = (rows: MeasurementCompareRow[], window: number): MeasurementCompareRow[] => {
  if (window <= 1 || rows.length < 2) {
    return rows;
  }
  // In time order (the backend sends the newest first).
  const order = rows
    .map((row, index) => ({ index, ms: parseTimestamp(row.last_fetched) ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => a.ms - b.ms)
    .map(({ index }) => index);
  const inOrder = order.map((index) => rows[index]);
  const samples = smoothColumns(
    inOrder.map((row) => row.samples),
    window,
  );
  const pairs = smoothColumns(
    inOrder.map((row) => row.pair_abs_values),
    window,
  );
  const smoothed = [...rows];
  order.forEach((index, position) => {
    smoothed[index] = {
      ...rows[index],
      samples: samples[position] ?? rows[index].samples,
      ...(rows[index].pair_abs_values ? { pair_abs_values: pairs[position] } : {}),
    };
  });
  return smoothed;
};
