import { describe, expect, it } from 'vitest';
import type {
  SensorHeatmapPoint,
  SensorHeatmapResponse,
} from '../components/device/sensorHeatmapTypes';
import {
  alarmSpansOf,
  finiteValue,
  frameValue,
  highestOf,
  historySpecFor,
  planViewsOf,
  sensorLinesOf,
  sensorRowsOf,
  sensorStatsOf,
  severityColor,
  toggledSet,
  viewHeatmapOf,
  viewPointsOf,
  worstSeverityOf,
  zeitreiheSeriesOf,
  zonePointsOf,
  type VerdachtsstelleCluster,
} from './locationStatusData';

const DAY_MS = 24 * 60 * 60 * 1000;

const point = (pos: number, extra: Partial<SensorHeatmapPoint> = {}): SensorHeatmapPoint => ({
  pos,
  x: pos / 10,
  y: 0.5,
  ...extra,
});

const heatmapOf = (data: SensorHeatmapResponse['data'], extra: Partial<SensorHeatmapResponse> = {}) =>
  ({ data, timestamps: [100, 200, 300], ...extra }) as SensorHeatmapResponse;

const cluster = (extra: Partial<VerdachtsstelleCluster> = {}): VerdachtsstelleCluster => ({
  id: 'c1',
  sensor_id: 1,
  device_ids: [],
  device_label: null,
  device_type: null,
  alarm_ids: [],
  state: 'neu',
  active: true,
  severity: 'alarm',
  max_value: null,
  since: null,
  resolved_at: null,
  ack_by: null,
  ack_at: null,
  pending_ack_alarm_ids: [],
  alarms: [],
  ...extra,
});

describe('finiteValue / highestOf / toggledSet', () => {
  it('turns readings into finite numbers or null', () => {
    expect(finiteValue(3)).toBe(3);
    expect(finiteValue('4.5')).toBe(4.5);
    expect(finiteValue(null)).toBeNull();
    expect(finiteValue(undefined)).toBeNull();
    expect(finiteValue('x')).toBeNull();
  });

  it('finds the highest value, skipping missing ones', () => {
    expect(highestOf([1, null, 5, undefined, 3])).toBe(5);
    expect(highestOf([null, undefined])).toBeNull();
    expect(highestOf([-2, -7])).toBe(-2);
  });

  it('toggles a value without touching the original set', () => {
    const set = new Set(['a']);
    expect([...toggledSet(set, 'b')]).toEqual(['a', 'b']);
    expect([...toggledSet(set, 'a')]).toEqual([]);
    expect([...set]).toEqual(['a']);
  });
});

describe('frameValue', () => {
  const heatmap = heatmapOf({ '1': [1, null, 3] });

  it('reads the value of a sensor in a frame', () => {
    expect(frameValue(heatmap, 2, 1)).toBe(3);
    expect(frameValue(heatmap, 1, 1)).toBeNull();
  });

  it('is null without heatmap, frame or sensor', () => {
    expect(frameValue(null, 0, 1)).toBeNull();
    expect(frameValue(heatmap, null, 1)).toBeNull();
    expect(frameValue(heatmap, 0, 9)).toBeNull();
  });
});

describe('historySpecFor', () => {
  const now = Date.UTC(2026, 9, 30);

  it('covers the measurement range', () => {
    const spec = historySpecFor(
      { first: '2026-10-01T00:00:00Z', last: '2026-10-29T00:00:00Z', count: 10 },
      false,
      now,
    );
    expect(spec).not.toBeNull();
    expect(spec!.from).toBeLessThanOrEqual(Date.parse('2026-10-01T00:00:00Z'));
    expect(spec!.to).toBeGreaterThanOrEqual(Date.parse('2026-10-29T00:00:00Z'));
  });

  it('falls back to the last 90 days without measurements or on failure', () => {
    for (const spec of [
      historySpecFor({ first: null, last: null, count: 0 }, false, now),
      historySpecFor(null, true, now),
    ]) {
      expect(spec).not.toBeNull();
      expect(spec!.from).toBeLessThanOrEqual(now - 90 * DAY_MS);
      expect(spec!.to).toBeGreaterThanOrEqual(now);
    }
  });

  it('is null while the range is still loading', () => {
    expect(historySpecFor(null, false, now)).toBeNull();
  });
});

describe('plan views', () => {
  const plans = [
    { id: 1, is_active: false },
    { id: 2, is_active: true },
    { id: 3, is_active: true },
  ];

  it('are the active plans, else the newest one', () => {
    expect(planViewsOf(heatmapOf({}, { location: { lageplans: plans } })).map((p) => p.id)).toEqual([2, 3]);
    expect(
      planViewsOf(heatmapOf({}, { location: { lageplans: [{ id: 7 }, { id: 6 }] } })).map((p) => p.id),
    ).toEqual([7]);
    expect(planViewsOf(null)).toEqual([]);
  });

  it('show their own points; unassigned points stay on the first view', () => {
    const views = [plans[1], plans[2]];
    const points = [point(1, { lageplan: 2 }), point(2, { lageplan: 3 }), point(3), point(4, { lageplan: 1 })];
    expect(viewPointsOf(points, views, views[0]).map((p) => p.pos)).toEqual([1, 3, 4]);
    expect(viewPointsOf(points, views, views[1]).map((p) => p.pos)).toEqual([2]);
    // A single view shows everything.
    expect(viewPointsOf(points, [views[0]], views[0])).toBe(points);
  });

  it('cut the heatmap down to the shown plan and points', () => {
    const views = [plans[1], plans[2]];
    const heatmap = heatmapOf({}, { location: { lageplans: views } });
    const viewPoints = [point(2)];
    const viewHeatmap = viewHeatmapOf(heatmap, views, views[1], viewPoints);
    expect(viewHeatmap?.location?.lageplans).toEqual([views[1]]);
    expect(viewHeatmap?.sensor_points).toBe(viewPoints);
    expect(viewHeatmapOf(heatmap, [views[0]], views[0], viewPoints)).toBe(heatmap);
  });
});

describe('sensorLinesOf', () => {
  it('joins the sensors of a grid row, named by their common name', () => {
    const lines = sensorLinesOf(
      [
        point(3, { grid_y: 1, name: 'Nord' }),
        point(1, { grid_y: 1, name: 'Nord' }),
        point(2, { grid_y: 0, name: 'A' }),
        point(4, { grid_y: 0, name: 'B' }),
        point(5, { name: 'Einzeln' }),
        point(6),
      ],
      (row) => `Linie ${row + 1}`,
    );
    expect(lines.map(({ key, label, points }) => [key, label, points.map((p) => p.pos)])).toEqual([
      ['row-0', 'Linie 1', [2, 4]],
      ['row-1', 'Nord', [1, 3]],
      ['single-5', 'Einzeln', [5]],
      ['single-6', '#6', [6]],
    ]);
  });
});

describe('zonePointsOf', () => {
  const points = [point(1, { grid_y: 0, last_value: 7, x_m: 1, y_m: 2 }), point(2, { threshold: 50 })];
  const heatmap = heatmapOf({ '1': [10, 20, 30] });

  it('takes the shown frame, else the newest value, and the threshold override', () => {
    const zones = zonePointsOf({ points, lines: null, heatmap, frameIndex: 1, threshold: 100 });
    expect(zones.map((zone) => [zone.value, zone.threshold, zone.meters])).toEqual([
      [20, 100, [1, 2]],
      [null, 50, null],
    ]);
    expect(zones[0]).not.toHaveProperty('group');
    expect(zonePointsOf({ points, lines: null, heatmap, frameIndex: null, threshold: 100 })[0].value).toBe(7);
  });

  it('groups the points of a line', () => {
    const lines = sensorLinesOf(points, () => 'Linie');
    const zones = zonePointsOf({ points, lines, heatmap, frameIndex: 0, threshold: null });
    expect(zones.map((zone) => [zone.group, zone.groupLabel])).toEqual([
      ['row-0', 'Linie'],
      [null, '#2'],
    ]);
  });
});

describe('sensorStatsOf / sensorRowsOf', () => {
  const heatmap = heatmapOf({ '1': [10, 40, null], '2': [5, 'x' as never, 8], '10': [1, 1, 1] });
  const stats = sensorStatsOf(heatmap);

  it('collects the newest and the highest value per sensor', () => {
    expect(stats.get('1')).toEqual({ latest: 40, max: 40 });
    expect(stats.get('2')).toEqual({ latest: 8, max: 8 });
  });

  const base = { heatmap, stats, threshold: 100, lines: [] };

  it('lists the heatmap series without placed measure points', () => {
    const rows = sensorRowsOf({ ...base, frameIndex: null, hasMeasurePoints: false, points: [] });
    expect(rows.map((row) => [row.key, row.label, row.value, row.max])).toEqual([
      ['1', '#1', 40, 40],
      ['2', '#2', 8, 8],
      ['10', '#10', 1, 1],
    ]);
  });

  it('lists the placed sensors at the shown frame', () => {
    const points = [point(1, { name: 'Ecke', threshold: 30 }), point(2)];
    const rows = sensorRowsOf({ ...base, frameIndex: 0, hasMeasurePoints: true, points });
    expect(rows.map((row) => [row.label, row.value, row.threshold])).toEqual([
      ['Ecke', 10, 30],
      ['#2', 5, 100],
    ]);
  });

  it('prefers the last value of a point over the series without a frame', () => {
    const rows = sensorRowsOf({
      ...base,
      frameIndex: null,
      hasMeasurePoints: true,
      points: [point(1, { last_value: 3 }), point(2)],
    });
    expect(rows.map((row) => row.value)).toEqual([3, 8]);
  });

  it('gives a line its strongest reading and strictest threshold', () => {
    const points = [point(1, { grid_y: 0, threshold: 60 }), point(2, { grid_y: 0, threshold: 40 })];
    const lines = sensorLinesOf(points, () => 'Linie 1');
    const [row] = sensorRowsOf({ ...base, frameIndex: 2, hasMeasurePoints: true, points, lines });
    expect(row).toEqual({ key: 'row-0', label: 'Linie 1', value: 8, max: 40, threshold: 40 });
  });
});

describe('zeitreiheSeriesOf', () => {
  const zeitreihe = { timestamps: [0, 60], data: { '2': [1, 2], '1': [3, null] } };

  it('puts the sensors with a Verdachtsstelle first, the others muted', () => {
    const series = zeitreiheSeriesOf(
      zeitreihe,
      [cluster({ sensor_id: 2 })],
      (id) => `S${id}`,
      (id) => id * 10,
    );
    expect(series.map((entry) => [entry.id, entry.label, entry.threshold, entry.muted])).toEqual([
      ['sensor-2', 'S2', 20, false],
      ['sensor-1', 'S1', 10, true],
    ]);
    expect(series[0].points[1]).toEqual({
      id: '2:1',
      triggered_at: new Date(60_000).toISOString(),
      value: 2,
    });
  });

  it('mutes nothing without Verdachtsstellen', () => {
    const series = zeitreiheSeriesOf(zeitreihe, [], String, () => null);
    expect(series.map((entry) => [entry.id, entry.muted])).toEqual([
      ['sensor-1', false],
      ['sensor-2', false],
    ]);
    expect(zeitreiheSeriesOf(null, [], String, () => null)).toEqual([]);
  });
});

describe('alarmSpansOf', () => {
  it('runs active alarms until now and skips ones without a start', () => {
    const since = '2026-10-01T00:00:00Z';
    const resolved = '2026-10-02T00:00:00Z';
    const spans = alarmSpansOf(
      [
        cluster({ id: 'a', since }),
        cluster({ id: 'b', since, resolved_at: resolved }),
        cluster({ id: 'c' }),
      ],
      5_000_000_000_000,
      (entry, _from, to) => `${entry.id}:${to == null ? 'active' : 'resolved'}`,
    );
    expect(spans).toEqual([
      { key: 'a', from: Date.parse(since), to: 5_000_000_000_000, label: 'a:active' },
      { key: 'b', from: Date.parse(since), to: Date.parse(resolved), label: 'b:resolved' },
    ]);
  });
});

describe('worstSeverityOf / severityColor', () => {
  it('picks the worst severity and its colour', () => {
    expect(worstSeverityOf([])).toBeNull();
    expect(
      worstSeverityOf([
        cluster({ severity: 'beobachten' }),
        cluster({ severity: 'kritisch' }),
        cluster({ severity: 'alarm' }),
      ]),
    ).toBe('kritisch');
    expect(severityColor(null)).toBe('#3F7A1C');
    expect(severityColor('kritisch')).toBe('#C44D26');
  });
});
