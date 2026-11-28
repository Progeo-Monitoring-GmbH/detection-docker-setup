/**
 * /analyse: the heatmap and measurement responses, and their loads kept by
 * period (analyseCache.ts) - used by useAnalyseLoads.ts.
 */
import type { MeasurementCompareRow } from '../components/device/MeasurementSamplesCompareChart.tsx';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import {
  type CachedLoad,
  cachedPeriod,
  type MeasurementsLoad,
  withLoad,
} from './analyseCache';
import { offlineSpansOf } from './analyseDevices';

export type LoadCache<T> = Map<string, CachedLoad<T>[]>;

type MeasurementsData = {
  measurements?: MeasurementCompareRow[] | null;
  total?: number | string | null;
  devices?: MeasurementsLoad['devices'] | null;
  device?: number | null;
  offline?: unknown;
} | null;

/** `&device=<id>` - nothing without a device (the backend's default). */
export const deviceQuery = (device: number | null) =>
  device != null ? `&device=${device}` : '';

/** The rows of a measurements response. */
export const measurementRowsOf = (data: MeasurementsData | undefined) =>
  (data?.measurements || []) as MeasurementCompareRow[];

/** A measurements response as a load: its rows, the period's total, the
 * location's devices and the device shown. */
export const measurementsLoadOf = (
  data: MeasurementsData | undefined,
): MeasurementsLoad => {
  const rows = measurementRowsOf(data);
  return {
    rows,
    total: Number(data?.total ?? rows.length),
    devices: data?.devices || [],
    device: data?.device ?? null,
    offline: offlineSpansOf(data?.offline),
  };
};

/** A heatmap holds the whole period when it has every frame of it. */
export const heatmapComplete = (data: SensorHeatmapResponse) => {
  const frames = data.timestamps?.length ?? 0;
  return (data.total ?? frames) <= frames;
};

/** The cached load of `key` covering the period (cut to it), else null. */
export const recallLoad = <T>(
  cache: LoadCache<T>,
  key: string,
  days: number,
  limit: number,
  cut: (value: T, fromMs: number) => T,
) => cachedPeriod(cache.get(key), days, limit, Date.now(), cut);

/** Keep a load of `key` for the period. */
export const rememberLoad = <T>(
  cache: LoadCache<T>,
  key: string,
  load: { days: number; limit: number; complete: boolean; value: T },
) => {
  const now = Date.now();
  cache.set(key, withLoad(cache.get(key), { ...load, loadedAt: now }, now));
};
