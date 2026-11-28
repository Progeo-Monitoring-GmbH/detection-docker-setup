/**
 * /analyse "all devices": the measurements of every device of the location
 * in one set of plots. Each device counts its own pairs from 1 and measures
 * at its own times, so
 *
 * - its pairs follow the previous device's (deviceLayoutOf: offset, count);
 * - measurements of the devices close together (MOMENT_MS) are one moment,
 *   and a device without a measurement in it keeps its newest one - up to
 *   OFFLINE_GAP_MS, after that it counts 0 (it is offline: shaded gray);
 * - a plan point (device + pair) gets the pair of the combined row
 *   (combinedPoints) - the selection helpers (analyseSelection.ts,
 *   analyseSensorSwitch.ts) then work on them as on a single device;
 * - the plots name a sensor by its device (namingOf).
 */
import type { MeasurementCompareRow } from '../components/device/MeasurementSamplesCompareChart';
import type { SensorNaming } from '../components/device/sensorNaming';
import { parseTimestamp } from './alarmUtils';

/** A device silent for longer is offline (the backend's OFFLINE_GAP). */
const OFFLINE_GAP_MS = 24 * 60 * 60 * 1000;
/** Measurements of the devices this close together form one moment. */
const MOMENT_MS = 15 * 60 * 1000;

export type TimeSpan = { from: number; to: number };

/** One device's measurements of the period. */
export type DeviceLoad = {
  device: number;
  name: string;
  /** Newest first, as the backend sends them. */
  rows: MeasurementCompareRow[];
  total: number;
  offline: TimeSpan[];
};

/** Where a device's pairs sit in the combined rows (index from 0). */
export type DeviceSpan = {
  device: number;
  name: string;
  offset: number;
  pairs: number;
};

/** The `offline` spans of a measurements response (ISO strings) in ms. */
export const offlineSpansOf = (raw: unknown): TimeSpan[] =>
  Array.isArray(raw)
    ? raw.flatMap((entry) => {
        const from = parseTimestamp(entry?.from);
        const to = parseTimestamp(entry?.to);
        return from != null && to != null && to > from ? [{ from, to }] : [];
      })
    : [];

/** `spans` sorted, overlapping ones joined. */
export const mergedSpans = (spans: readonly TimeSpan[]): TimeSpan[] =>
  [...spans]
    .sort((a, b) => a.from - b.from)
    .reduce<TimeSpan[]>((merged, span) => {
      const last = merged[merged.length - 1];
      if (last && span.from <= last.to) {
        last.to = Math.max(last.to, span.to);
      } else {
        merged.push({ ...span });
      }
      return merged;
    }, []);

const pairCountOf = (row: MeasurementCompareRow) =>
  row.pair_abs_values?.length || Math.floor((row.samples?.length ?? 0) / 2);

/** |EP − WP| per pair - as the backend sent it, else from the samples. */
const absValuesOf = (row: MeasurementCompareRow): number[] => {
  if (row.pair_abs_values?.length) {
    return row.pair_abs_values.map((value) => Number(value || 0));
  }
  const samples = row.samples ?? [];
  return Array.from({ length: Math.floor(samples.length / 2) }, (_, pair) =>
    Math.abs(Number(samples[pair * 2] || 0) - Number(samples[pair * 2 + 1] || 0)),
  );
};

/** `values` cut or filled up with 0 to `length`. */
const fitted = (values: readonly number[], length: number) =>
  Array.from({ length }, (_, index) => Number(values[index] ?? 0) || 0);

/** The devices' places in the combined rows - in the order given, each as
 * wide as its widest measurement. */
const deviceLayoutOf = (loads: readonly DeviceLoad[]): DeviceSpan[] => {
  let offset = 0;
  return loads.map(({ device, name, rows }) => {
    const pairs = rows.reduce((most, row) => Math.max(most, pairCountOf(row)), 0);
    const span = { device, name, offset, pairs };
    offset += pairs;
    return span;
  });
};

type Entry = { slot: number; ms: number; row: MeasurementCompareRow };

/**
 * One row per moment (newest first, like a device's rows): every device's
 * pairs at their place of `layout` - its measurement of that moment, else
 * its newest one before (up to OFFLINE_GAP_MS), else 0. The row's id and
 * time are of the moment's newest measurement.
 */
export const combinedRows = (
  loads: readonly DeviceLoad[],
  layout: readonly DeviceSpan[],
): MeasurementCompareRow[] => {
  const slotOf = new Map(layout.map((span, slot) => [span.device, slot]));
  const entries: Entry[] = loads
    .flatMap(({ device, rows }) => {
      const slot = slotOf.get(device);
      return slot == null
        ? []
        : rows.flatMap((row) => {
            const ms = parseTimestamp(row.last_fetched);
            return ms == null ? [] : [{ slot, ms, row }];
          });
    })
    .sort((a, b) => a.ms - b.ms || a.slot - b.slot);

  const moments: Entry[][] = [];
  entries.forEach((entry) => {
    const moment = moments[moments.length - 1];
    if (moment && entry.ms - moment[0].ms <= MOMENT_MS) {
      moment.push(entry);
    } else {
      moments.push([entry]);
    }
  });

  const latest: (Entry | null)[] = layout.map(() => null);
  const rows = moments.map((moment) => {
    moment.forEach((entry) => {
      latest[entry.slot] = entry;
    });
    const newest = moment[moment.length - 1];
    const samples: number[] = [];
    const absValues: number[] = [];
    layout.forEach(({ pairs }, slot) => {
      const entry = latest[slot];
      const fresh = entry && newest.ms - entry.ms <= OFFLINE_GAP_MS ? entry.row : null;
      samples.push(...fitted(fresh?.samples ?? [], pairs * 2));
      absValues.push(...fitted(fresh ? absValuesOf(fresh) : [], pairs));
    });
    return {
      id: newest.row.id,
      device: newest.row.device,
      last_fetched: newest.row.last_fetched,
      samples,
      pair_abs_values: absValues,
    };
  });
  return rows.reverse();
};

/**
 * The plan points with the pair of the combined rows (1-based, like a
 * device's) and no device - so they match the combined "device" (null).
 * Points of no device of `layout` are left out: their place is unknown.
 */
export const combinedPoints = <
  P extends { pos: number; device?: number | null; pair?: number | null },
>(
  points: readonly P[],
  layout: readonly DeviceSpan[],
): P[] =>
  points.flatMap((point) => {
    const span = layout.find(({ device }) => device === point.device);
    return span
      ? [{ ...point, device: null, pair: span.offset + (point.pair ?? point.pos) }]
      : [];
  });

/** The device of a combined pair (index from 0) and its own pair (from 1). */
export const devicePairOf = (layout: readonly DeviceSpan[], sensor: number) => {
  const span = layout.find(
    ({ offset, pairs }) => sensor >= offset && sensor < offset + pairs,
  );
  return span ? { span, pair: sensor - span.offset + 1 } : null;
};

/** The plots' names of the combined pairs: "<device> · Sensor 5", "5" under
 * a column, a divider per device. */
export const namingOf = (
  layout: readonly DeviceSpan[],
  pairLabel: string,
): SensorNaming => ({
  name: (sensor) => {
    const at = devicePairOf(layout, sensor);
    return at
      ? `${at.span.name} · ${pairLabel} ${at.pair}`
      : `${pairLabel} ${sensor + 1}`;
  },
  tick: (sensor) => String(devicePairOf(layout, sensor)?.pair ?? sensor + 1),
  groups: layout
    .filter(({ pairs }) => pairs > 0)
    .map(({ offset, name }) => ({ start: offset, label: name })),
});

/** Everything of the devices' loads as one: rows, total, offline spans. */
export const combinedLoad = (loads: readonly DeviceLoad[]) => {
  const layout = deviceLayoutOf(loads);
  const rows = combinedRows(loads, layout);
  // The moments plus what the backend left out of each device ("spread"):
  // more than the rows only when a device was thinned.
  const leftOut = loads.reduce(
    (sum, load) => sum + Math.max(load.total - load.rows.length, 0),
    0,
  );
  return {
    layout,
    rows,
    total: rows.length + leftOut,
    offline: mergedSpans(loads.flatMap((load) => load.offline)),
  };
};
