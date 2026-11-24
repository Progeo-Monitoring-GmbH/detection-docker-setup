import { describe, expect, it } from 'vitest';
import {
  computedSuspicionUrl,
  effectiveSuspicionMode,
  pointLetter,
  sensorList,
  suspicionMarkersOf,
  suspicionsAtFrame,
  suspicionsOnPlan,
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
  alarms: [],
  ...overrides,
});

describe('effectiveSuspicionMode', () => {
  it('always shows customers the computed points', () => {
    expect(effectiveSuspicionMode(false, 'sensors')).toBe('computed');
  });

  it('lets staff pick', () => {
    expect(effectiveSuspicionMode(true, 'sensors')).toBe('sensors');
    expect(effectiveSuspicionMode(true, 'computed')).toBe('computed');
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

describe('suspicionMarkersOf - unplaced sensors', () => {
  it('gives them no ring but keeps the letters of the others', () => {
    const markers = suspicionMarkersOf([
      point('a'),
      point('b', { x: null, y: null, lageplan: null }),
      point('c'),
    ]);
    expect(markers.map((marker) => [marker.id, marker.label])).toEqual([
      ['a', 'A'],
      ['c', 'C'],
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

describe('suspicionsAtFrame', () => {
  // Hourly frames from 08:00 to 11:00 (UTC, seconds).
  const at = (hhmm: string) => Date.parse(`2026-11-02T${hhmm}:00Z`);
  const timestamps = ['08:00', '09:00', '10:00', '11:00'].map(
    (hhmm) => at(hhmm) / 1000,
  );
  const markers = suspicionMarkersOf([
    point('early', {
      first_seen: '2026-11-02T08:20:00Z',
      last_seen: '2026-11-02T09:10:00Z',
    }),
    point('once', {
      first_seen: '2026-11-02T10:30:00Z',
      last_seen: '2026-11-02T10:30:00Z',
    }),
    point('late', { first_seen: '2026-11-02T12:40:00Z', last_seen: null }),
    point('unknown'),
  ]);
  const shownAt = (frame: number | null) =>
    suspicionsAtFrame(markers, timestamps, frame)?.map((marker) => marker.id);

  it('reads the detection of the points', () => {
    expect(markers[0].seenFrom).toBe(at('08:20'));
    expect(markers[0].seenUntil).toBe(at('09:10'));
    expect(markers[3].seenFrom).toBeNull();
  });

  it('shows a point only on the frames it was detected in', () => {
    expect(shownAt(0)).toEqual(['early', 'unknown']);
    expect(shownAt(1)).toEqual(['early', 'unknown']);
    // A single reading: its frame only.
    expect(shownAt(2)).toEqual(['once', 'unknown']);
    // The newest frame reaches up to now.
    expect(shownAt(3)).toEqual(['late', 'unknown']);
  });

  it('shows all without a frame', () => {
    expect(shownAt(null)).toHaveLength(4);
    expect(suspicionsAtFrame(markers, undefined, 2)).toBe(markers);
    expect(suspicionsAtFrame(undefined, timestamps, 2)).toBeUndefined();
  });
});
