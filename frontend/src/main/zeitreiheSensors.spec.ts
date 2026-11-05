import { describe, expect, it } from 'vitest';
import {
  defaultZeitreiheIds,
  toggledId,
  ZEITREIHE_DEFAULT_SENSORS,
  zeitreiheSensorsOf,
} from './zeitreiheSensors';

const zeitreiheOf = (data: Record<string, Array<number | null>>) => ({
  timestamps: data[Object.keys(data)[0]].map((_value, index) => index * 60),
  data,
});

describe('zeitreiheSensorsOf', () => {
  it('classifies relative to each threshold - a sensor can be in several tables', () => {
    const sensors = zeitreiheSensorsOf(
      zeitreiheOf({
        '1': [50, 150], // above 100, span 100 = 1x
        '2': [40, 41], // span 1 = 0.01x
        '3': [10, 40], // span 30 = 0.3x
      }),
      (id) => `S${id}`,
      () => 100,
    );
    expect(sensors.map((s) => [s.id, s.triggered, s.active, s.silent])).toEqual([
      ['sensor-1', true, true, false],
      ['sensor-2', false, false, true],
      ['sensor-3', false, true, false],
    ]);
    expect(sensors[0]).toMatchObject({ label: 'S1', min: 50, max: 150, range: 100, peakRatio: 1.5, trend: 200 });
    expect(sensors[0].points[1]).toEqual({ id: '1:1', triggered_at: new Date(60_000).toISOString(), value: 150 });
  });

  it('takes the trend from the first to the last value, skips gaps and empty sensors', () => {
    const sensors = zeitreiheSensorsOf(
      { timestamps: [0, 60, 120], data: { '1': [null, 80, 60], '2': [null, null, null], '3': [0, 5, 5] } },
      String,
      () => 100,
    );
    expect(sensors.map((sensor) => [sensor.sensorId, sensor.trend])).toEqual([
      [1, -25],
      // From 0: no percentage.
      [3, null],
    ]);
  });

  it('never calls a sensor triggered without a threshold', () => {
    const [sensor] = zeitreiheSensorsOf(zeitreiheOf({ '1': [500, 900] }), String, () => null);
    expect(sensor.triggered).toBe(false);
    expect(sensor.active).toBe(true);
    expect(zeitreiheSensorsOf(null, String, () => null)).toEqual([]);
  });
});

describe('defaultZeitreiheIds', () => {
  it('plots the triggered first (highest peak), then the most active', () => {
    const sensors = zeitreiheSensorsOf(
      zeitreiheOf({
        '1': [10, 40], // active 0.3x
        '2': [90, 120], // triggered, peak 1.2x
        '3': [40, 41], // silent
        '4': [100, 300], // triggered, peak 3x
        '5': [10, 90], // active 0.8x
      }),
      String,
      () => 100,
    );
    expect(defaultZeitreiheIds(sensors)).toEqual(['sensor-4', 'sensor-2', 'sensor-5', 'sensor-1', 'sensor-3']);
  });

  it(`plots ${ZEITREIHE_DEFAULT_SENSORS} at most`, () => {
    const data = Object.fromEntries(Array.from({ length: 9 }, (_v, i) => [String(i + 1), [0, 200 + i]]));
    const ids = defaultZeitreiheIds(zeitreiheSensorsOf(zeitreiheOf(data), String, () => 100));
    expect(ids).toEqual(['sensor-9', 'sensor-8', 'sensor-7', 'sensor-6', 'sensor-5']);
  });
});

describe('toggledId', () => {
  it('appends a new id and keeps the order of the others', () => {
    expect(toggledId(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(toggledId(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });
});
