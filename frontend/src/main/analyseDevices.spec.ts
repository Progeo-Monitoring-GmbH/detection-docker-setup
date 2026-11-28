import { describe, expect, it } from 'vitest';
import {
  combinedLoad,
  combinedPoints,
  type DeviceLoad,
  devicePairOf,
  mergedSpans,
  namingOf,
  offlineSpansOf,
} from './analyseDevices';
import { planSensorPick, selectedPositionsOf } from './analyseSelection';
import { sensorOrderOf } from './analyseSensorSwitch';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-20T00:00:00Z');
const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString();

/** A measurement of `device` at `hours`, its pairs' |EP − WP| `values`. */
const row = (id: number, device: number, hours: number, values: number[]) => ({
  id,
  device,
  last_fetched: at(hours),
  samples: values.flatMap((value) => [0, value]),
});

const load = (device: number, name: string, rows: ReturnType<typeof row>[], total = rows.length): DeviceLoad => ({
  device,
  name,
  rows: [...rows].reverse(),
  total,
  offline: [],
});

describe('combinedLoad', () => {
  it('puts the devices pairs one after another, per moment', () => {
    const { layout, rows, total } = combinedLoad([
      load(7, 'Box A', [row(1, 7, 0, [1, 2]), row(3, 7, 1, [3, 4])]),
      // 5 minutes after box A: the same moment.
      load(9, 'Box B', [row(2, 9, 1 / 12, [10, 20, 30]), row(4, 9, 1 + 1 / 12, [40, 50, 60])]),
    ]);

    expect(layout).toEqual([
      { device: 7, name: 'Box A', offset: 0, pairs: 2 },
      { device: 9, name: 'Box B', offset: 2, pairs: 3 },
    ]);
    // Newest first; id and time of the moment's newest measurement.
    expect(rows.map((entry) => [entry.id, entry.pair_abs_values])).toEqual([
      [4, [3, 4, 40, 50, 60]],
      [2, [1, 2, 10, 20, 30]],
    ]);
    expect(rows[0].last_fetched).toBe(at(1 + 1 / 12));
    expect(rows[0].samples).toEqual([0, 3, 0, 4, 0, 40, 0, 50, 0, 60]);
    expect(total).toBe(2);
  });

  it('keeps a silent device`s newest measurement up to a day, then 0', () => {
    const { rows } = combinedLoad([
      load(7, 'Box A', [row(1, 7, 0, [5]), row(2, 7, 10, [6]), row(3, 7, 30, [7])]),
      load(9, 'Box B', [row(4, 9, 0, [1])]),
    ]);

    expect(rows.map((entry) => entry.pair_abs_values)).toEqual([
      [7, 0], // 30 h after box B's only one: offline
      [6, 1],
      [5, 1],
    ]);
  });

  it('counts what the backend left out of a device as not shown', () => {
    const { total } = combinedLoad([
      load(7, 'Box A', [row(1, 7, 0, [1])], 40),
      load(9, 'Box B', [row(2, 9, 0, [1])]),
    ]);

    expect(total).toBe(1 + 39);
  });
});

describe('offline spans', () => {
  it('reads the response`s spans and joins overlapping ones', () => {
    const spans = offlineSpansOf([
      { from: at(0), to: at(30) },
      { from: at(50), to: 'nonsense' },
    ]);
    expect(spans).toEqual([{ from: T0, to: T0 + 30 * HOUR }]);
    expect(offlineSpansOf(null)).toEqual([]);

    expect(
      mergedSpans([
        { from: 40, to: 60 },
        { from: 0, to: 30 },
        { from: 20, to: 35 },
      ]),
    ).toEqual([
      { from: 0, to: 35 },
      { from: 40, to: 60 },
    ]);
  });
});

describe('the plan points on the combined pairs', () => {
  const layout = [
    { device: 7, name: 'Box A', offset: 0, pairs: 2 },
    { device: 9, name: 'Box B', offset: 2, pairs: 3 },
  ];
  const points = [
    { pos: 11, device: 7, pair: 1 },
    { pos: 12, device: 7, pair: 2 },
    { pos: 21, device: 9, pair: 1 },
    { pos: 23, device: 9, pair: 3, disabled: true },
    { pos: 99, device: 5, pair: 1 },
  ];

  it('selects, names and switches them as on one device', () => {
    const combined = combinedPoints(points, layout);

    expect(combined.map((point) => [point.pos, point.pair, point.device])).toEqual([
      [11, 1, null],
      [12, 2, null],
      [21, 3, null],
      [23, 5, null],
    ]);
    // A click on box B's first sensor selects combined pair index 2 - no device switch.
    expect(planSensorPick(combined, 21, null, [7, 9])).toEqual({ device: null, pair: 2 });
    expect(selectedPositionsOf(combined, [2, 4], null)).toEqual([21, 23]);
    expect(sensorOrderOf(combined, null, 4, 2)).toBe(23);
  });

  it('names a pair by its device', () => {
    const naming = namingOf(layout, 'Sensor');

    expect(naming.name(3)).toBe('Box B · Sensor 2');
    expect(naming.tick(3)).toBe('2');
    expect(naming.groups).toEqual([
      { start: 0, label: 'Box A' },
      { start: 2, label: 'Box B' },
    ]);
    expect(devicePairOf(layout, 9)).toBeNull();
  });
});
