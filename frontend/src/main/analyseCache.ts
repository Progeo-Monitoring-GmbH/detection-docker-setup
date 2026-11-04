import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import type { MeasurementCompareRow } from '../components/device/MeasurementSamplesCompareChart';
import { parseTimestamp } from './alarmUtils';

/**
 * The Analyse tab's loads by period (?days=) and resolution (?limit=), so
 * switching doesn't load again what is already there: a period loaded before
 * at that resolution is reused as it is, a shorter one is cut out of a longer
 * load - but only out of a complete one. The backend spreads at most `limit`
 * measurements over a period; a thinned load would give a shorter period far
 * fewer points than its own. A complete load holds every measurement, so it
 * serves any resolution.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a load is reused - newer measurements come with the next one. */
export const CACHE_MAX_AGE_MS = 5 * 60 * 1000;

export type CachedLoad<T> = {
  days: number;
  /** The resolution it was loaded with (?limit=). */
  limit: number;
  /** Holds every measurement of its period (not thinned). */
  complete: boolean;
  /** Epoch ms. */
  loadedAt: number;
  value: T;
};

/**
 * What serves a `days` period at resolution `limit` from `loads`: a load of
 * that period (at that resolution, or complete), else the shortest complete
 * longer one, cut to the period by `cut` (its start, ms). null: none - load it.
 */
export const cachedPeriod = <T>(
  loads: CachedLoad<T>[] | undefined,
  days: number,
  limit: number,
  now: number,
  cut: (value: T, fromMs: number) => T,
): T | null => {
  const fresh = (loads ?? []).filter((load) => now - load.loadedAt < CACHE_MAX_AGE_MS);
  const own = fresh.find((load) => load.days === days && (load.limit === limit || load.complete));
  if (own) {
    return own.value;
  }
  const longer = fresh
    .filter((load) => load.complete && load.days > days)
    .sort((a, b) => a.days - b.days)[0];
  return longer ? cut(longer.value, now - days * DAY_MS) : null;
};

/** `loads` with `load` instead of an older load of its period and
 * resolution (and without expired ones). */
export const withLoad = <T>(loads: CachedLoad<T>[] | undefined, load: CachedLoad<T>, now: number) => [
  ...(loads ?? []).filter(
    (entry) =>
      !(entry.days === load.days && entry.limit === load.limit) && now - entry.loadedAt < CACHE_MAX_AGE_MS,
  ),
  load,
];

/** The heatmap from `fromMs` on: its frames there and their values. */
export const cutHeatmap = (heatmap: SensorHeatmapResponse | null, fromMs: number): SensorHeatmapResponse | null => {
  if (!heatmap) {
    return heatmap;
  }
  const timestamps = heatmap.timestamps ?? [];
  const first = timestamps.findIndex((seconds) => seconds * 1000 >= fromMs);
  const start = first < 0 ? timestamps.length : first;
  const data = Object.fromEntries(
    Object.entries(heatmap.data ?? {}).map(([sensor, values]) => [sensor, values.slice(start)]),
  );
  const kept = timestamps.slice(start);
  return { ...heatmap, timestamps: kept, data, total: kept.length };
};

export type MeasurementsLoad = {
  rows: MeasurementCompareRow[];
  total: number;
  devices: { id: number; display_name: string }[];
  device: number | null;
};

/** The measurements from `fromMs` on. */
export const cutMeasurements = (load: MeasurementsLoad, fromMs: number): MeasurementsLoad => {
  const rows = load.rows.filter((row) => (parseTimestamp(row.last_fetched) ?? Number.NEGATIVE_INFINITY) >= fromMs);
  return { ...load, rows, total: rows.length };
};
