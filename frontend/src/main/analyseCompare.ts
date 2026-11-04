import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';

/**
 * The Analyse tab's comparison with the past: the same period, shifted back
 * by an offset - its measurements next to the current ones (a plot by
 * sensor), and on the heatmap the change of every sensor since then.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The offsets offered: days back, and their label (i18n analyse_compare_<key>). */
export const COMPARE_OFFSETS = [
  { days: 1, key: '1d' },
  { days: 7, key: '7d' },
  { days: 14, key: '14d' },
  { days: 30, key: '1m' },
  { days: 90, key: '3m' },
  { days: 180, key: '6m' },
  { days: 365, key: '1y' },
] as const;

export type CompareOffset = (typeof COMPARE_OFFSETS)[number];

/**
 * The offsets whose shifted period lies within the measured data: it must
 * start at or after the location's oldest measurement (`first`, ISO). None
 * while that is unknown.
 */
export const compareOffsetsFor = (
  first: string | null | undefined,
  periodDays: number,
  now: number,
): CompareOffset[] => {
  const oldest = first ? Date.parse(first) : Number.NaN;
  if (!Number.isFinite(oldest)) {
    return [];
  }
  return COMPARE_OFFSETS.filter((offset) => now - (offset.days + periodDays) * DAY_MS >= oldest);
};

/** The index of the time nearest to `seconds` in `sorted` (ascending); -1 without any. */
export const nearestIndex = (sorted: number[], seconds: number) => {
  if (!sorted.length) {
    return -1;
  }
  let low = 0;
  let high = sorted.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (sorted[middle] <= seconds) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return Math.abs(sorted[high] - seconds) < Math.abs(sorted[low] - seconds) ? high : low;
};

/**
 * The heatmap of the change: every sensor's value at each frame minus its
 * value `offsetMs` earlier (the frame of `past` nearest to then) - null
 * where either is missing. Frames and sensor points of `current`.
 */
export const heatmapChange = (
  current: SensorHeatmapResponse | null,
  past: SensorHeatmapResponse | null,
  offsetMs: number,
): SensorHeatmapResponse | null => {
  if (!current || !past) {
    return null;
  }
  const pastTimes = past.timestamps ?? [];
  const pastIndex = (current.timestamps ?? []).map((seconds) => nearestIndex(pastTimes, seconds - offsetMs / 1000));
  const data = Object.fromEntries(
    Object.entries(current.data ?? {}).map(([sensor, values]) => {
      const then = past.data?.[sensor] ?? [];
      return [
        sensor,
        values.map((value, index) => {
          const before = pastIndex[index] >= 0 ? then[pastIndex[index]] : null;
          return value == null || before == null ? null : value - before;
        }),
      ];
    }),
  );
  return { ...current, data };
};
