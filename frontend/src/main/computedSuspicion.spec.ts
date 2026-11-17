import { describe, expect, it } from 'vitest';
import {
  computedSuspicionUrl,
  effectiveSuspicionMode,
  pointLetter,
  sensorList,
  suspicionMarkersOf,
  suspicionsOnPlan,
  usesComputedSuspicion,
  type ComputedSuspicionPoint,
} from './computedSuspicion';

const point = (
  id: string,
  overrides: Partial<ComputedSuspicionPoint> = {},
): ComputedSuspicionPoint => ({
  id,
  x: 0.2,
  y: 0.3,
  lageplan: 5,
  strength: 1,
  sensor_ids: [1, 2],
  state: 'neu',
  active: true,
  severity: 'alarm',
  max_value: 250,
  max_exceedance: 2.5,
  first_seen: null,
  last_seen: null,
  readings: 3,
  alarm_ids: [10, 20],
  pending_ack_alarm_ids: [10],
  x_m: null,
  y_m: null,
  ...overrides,
});

describe('usesComputedSuspicion', () => {
  it('is on for smartex mx-PEEL only', () => {
    expect(usesComputedSuspicion(7)).toBe(true);
    expect(usesComputedSuspicion(1)).toBe(false);
    expect(usesComputedSuspicion(null)).toBe(false);
  });
});

describe('effectiveSuspicionMode', () => {
  it('always shows customers the computed points of an mx-PEEL object', () => {
    expect(effectiveSuspicionMode(true, false, 'sensors')).toBe('computed');
  });

  it('lets staff pick', () => {
    expect(effectiveSuspicionMode(true, true, 'sensors')).toBe('sensors');
    expect(effectiveSuspicionMode(true, true, 'computed')).toBe('computed');
  });

  it('is off for other products', () => {
    expect(effectiveSuspicionMode(false, true, 'computed')).toBeNull();
  });
});

describe('pointLetter', () => {
  it('letters the points like spreadsheet columns', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(pointLetter)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
    ]);
  });
});

describe('sensorList', () => {
  const label = (id: number) => `S${id}`;

  it('lists the sensors, at most `limit`', () => {
    expect(sensorList([1, 2], label)).toBe('S1, S2');
    expect(sensorList([1, 2, 3, 4, 5, 6], label, 4)).toBe('S1, S2, S3, S4 +2');
  });
});

describe('suspicionMarkersOf', () => {
  it('letters the markers in the order of the list', () => {
    const markers = suspicionMarkersOf([
      point('computed-1'),
      point('computed-7', { state: 'geloest', strength: 0.4 }),
    ]);

    expect(
      markers.map((marker) => [
        marker.id,
        marker.label,
        marker.state,
        marker.strength,
      ]),
    ).toEqual([
      ['computed-1', 'A', 'neu', 1],
      ['computed-7', 'B', 'geloest', 0.4],
    ]);
  });
});

describe('suspicionsOnPlan', () => {
  it('keeps the markers of the shown view and those of no plan', () => {
    const markers = suspicionMarkersOf([
      point('a', { lageplan: 5 }),
      point('b', { lageplan: 6 }),
      point('c', { lageplan: null }),
    ]);

    expect(suspicionsOnPlan(markers, 5)?.map((marker) => marker.id)).toEqual([
      'a',
      'c',
    ]);
    expect(suspicionsOnPlan(undefined, 5)).toBeUndefined();
  });
});

describe('computedSuspicionUrl', () => {
  it('asks for the range of the Status tab', () => {
    expect(computedSuspicionUrl(12, 30, false)).toBe(
      '/v1/alarm/computed-clusters/?location=12&days=30',
    );
    expect(computedSuspicionUrl(12, 1, true)).toBe(
      '/v1/demo/alarm-computed-clusters/?location=12&days=1',
    );
  });
});
