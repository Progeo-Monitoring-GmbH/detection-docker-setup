/**
 * The heatmap's frames, cut out of the location's history in the browser:
 * the history is loaded once in its base step (historyWindow), and every
 * window, step and Zeitreihe range is grouped from it - a frame's highest
 * values over 30 minutes add up exactly to the highest over an hour, a day,
 * ... Nothing is requested again when the window or step changes.
 */
import { alignDown } from './heatmapSteps';
import type { HeatmapWindow } from './heatmapSteps';
import type { SensorHeatmapResponse } from './sensorHeatmapTypes';

type Series = { timestamps: number[]; data: Record<string, Array<number | null>> };

const finiteOrNull = (raw: unknown) => {
  const value = raw == null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
};

/** Adds a history value to a sensor's frames: a new frame starts with it,
 * an ongoing one keeps its highest value. */
const addToFrame = (series: Array<number | null>, value: number | null, isNew: boolean) => {
  if (isNew) {
    series.push(value);
    return;
  }
  const current = series[series.length - 1];
  if (value != null && (current == null || value > current)) {
    series[series.length - 1] = value;
  }
};

/**
 * The frames of [from, to) in steps of `stepMs` from the step boundary at or
 * before `from` (local time): per frame and sensor the highest value of the
 * history frames that start in it. Frames without values are left out, like
 * the backend does.
 */
const group = (history: SensorHeatmapResponse, from: number, to: number, stepMs: number): Series => {
  const source = history.timestamps ?? [];
  const keys = Object.keys(history.data ?? {});
  const origin = alignDown(from, stepMs);
  const buckets: number[] = [];
  const values: Record<string, Array<number | null>> = Object.fromEntries(keys.map((key) => [key, []]));

  let last = Number.NaN;
  for (let index = 0; index < source.length; index += 1) {
    const ms = source[index] * 1000;
    if (!(ms >= origin && ms < to)) {
      continue;
    }
    const bucket = Math.floor((ms - origin) / stepMs);
    const isNew = bucket !== last;
    if (isNew) {
      buckets.push(bucket);
      last = bucket;
    }
    for (const key of keys) {
      addToFrame(values[key], finiteOrNull(history.data[key]?.[index]), isNew);
    }
  }
  return { timestamps: buckets.map((bucket) => (origin + bucket * stepMs) / 1000), data: values };
};

/** The heatmap of a window: the history's location and points with the
 * window's frames. */
export const framesOf = (
  history: SensorHeatmapResponse | null,
  window: HeatmapWindow,
): SensorHeatmapResponse | null => {
  if (!history) {
    return null;
  }
  const { timestamps, data } = group(history, window.from, window.to, window.step * 1000);
  return { ...history, timestamps, data };
};

/**
 * The Zeitreihe of [from, to): at most `maxPoints` frames, each the highest
 * value per sensor - the smallest multiple of the history's step that fits,
 * so a short leak still shows up in a year's chart.
 */
export const seriesOf = (
  history: SensorHeatmapResponse | null,
  from: number,
  to: number,
  maxPoints: number,
  baseStep: number,
): Series | null => {
  if (!history) {
    return null;
  }
  const baseMs = baseStep * 1000;
  const stepMs = Math.max(1, Math.ceil((to - from) / maxPoints / baseMs)) * baseMs;
  return group(history, from, to, stepMs);
};
