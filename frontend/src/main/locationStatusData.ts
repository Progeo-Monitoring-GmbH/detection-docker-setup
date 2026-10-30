/**
 * Derived data of LocationStatusView (extracted so it can be tested without
 * React): plan views, sensor lines, the plan's points, the sensor table, the
 * Zeitreihe and the Verdachtsstellen summary.
 */
import type { AlarmSpan } from '../components/device/FrameSlider';
import { historyWindow, type HeatmapWindow } from '../components/device/heatmapSteps';
import type { LageplanZonePoint } from '../components/device/LageplanZoneOverlay';
import type { SensorListRow } from '../components/device/SensorListTable';
import type {
  SensorHeatmapLageplanData,
  SensorHeatmapPoint,
  SensorHeatmapResponse,
} from '../components/device/sensorHeatmapTypes';
import type { ThresholdTrendSeries } from '../components/device/ThresholdTrendChart';
import type { Severity } from '../components/ui/kit/SeverityBadge';
import type { AlarmState } from '../components/ui/kit/StateBadge';
import type { MeasurementRange } from './timeRanges';

// The backend now owns severity/state/clustering entirely
// (ProgeoAlarm.severity, the auto-GELOEST transition, and
// AlarmViewSet.clusters) - the view just renders what it returns.
// A Verdachtsstelle is one sensor: every sensor_id an alarm reported as
// over-threshold, rolled up across every alarm that flagged it.
export type VerdachtsstelleCluster = {
  id: string;
  sensor_id: number;
  device_ids: number[];
  device_label: string | null;
  device_type: string | null;
  alarm_ids: number[];
  /** Current state: "geloest" once no alarm of this sensor is open anymore. */
  state: AlarmState;
  /** Whether an alarm of this sensor is still open (not normalized). */
  active: boolean;
  severity: Severity;
  max_value: number | null;
  /** Start of the sensor's latest alarm episode (re-triggers merged). */
  since: string | null;
  /** When that episode ended; null while still active. */
  resolved_at: string | null;
  ack_by: string | null;
  ack_at: string | null;
  pending_ack_alarm_ids: number[];
  alarms: {
    id: number | string;
    triggered_at: string | null;
    value: number | null;
    state: AlarmState;
  }[];
};

/** smartex® dm: the sensors of one grid row, drawn and listed as one line. */
export type SensorLine = {
  key: string;
  label: string;
  points: SensorHeatmapPoint[];
};

type SensorStats = Map<string, { latest: number | null; max: number | null }>;

const DAY_MS = 24 * 60 * 60 * 1000;
// History loaded without a known measurement range (none, or it failed).
const FALLBACK_HISTORY_DAYS = 90;
const SEVERITY_ORDER: Record<Severity, number> = {
  beobachten: 0,
  alarm: 1,
  kritisch: 2,
};
const SEVERITY_COLOR: Record<Severity, string> = {
  beobachten: '#9A7208',
  alarm: '#EB633B',
  kritisch: '#C44D26',
};
const NO_SEVERITY_COLOR = '#3F7A1C';

/** A raw reading as a number; null when missing or not finite. */
export const finiteValue = (raw: unknown) => {
  const value = raw == null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
};

/** Highest of the values, missing ones skipped; null without any. */
export const highestOf = (values: Iterable<number | null | undefined>) => {
  let best: number | null = null;
  for (const value of values) {
    if (value != null && (best == null || value > best)) {
      best = value;
    }
  }
  return best;
};

/** Lowest of the values, missing ones skipped; null without any. */
const lowestOf = (values: Iterable<number | null | undefined>) => {
  let best: number | null = null;
  for (const value of values) {
    if (value != null && (best == null || value < best)) {
      best = value;
    }
  }
  return best;
};

/** A copy of `set` with `value` added, or removed when it was in it. */
export const toggledSet = <T>(set: Set<T>, value: T) => {
  const next = new Set(set);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
};

/** A sensor's value in a frame of the heatmap; null without one. */
export const frameValue = (
  heatmap: SensorHeatmapResponse | null,
  index: number | null,
  sensor: number | string,
) => (heatmap && index != null ? finiteValue(heatmap.data?.[String(sensor)]?.[index]) : null);

/** Position of a measure point in meters; null while the plan isn't calibrated. */
export const measurePointMeters = (point: SensorHeatmapPoint | undefined): [number, number] | null =>
  point?.x_m != null && point.y_m != null ? [point.x_m, point.y_m] : null;

/**
 * Every measurement of the location in its base step; without a range (no
 * measurements yet, or it failed) the last FALLBACK_HISTORY_DAYS - the
 * response still brings the plans and measure points. Null while the range
 * is still loading.
 */
export const historySpecFor = (
  range: MeasurementRange | null,
  rangeFailed: boolean,
  now: number,
): HeatmapWindow | null => {
  const first = range?.first ? Date.parse(range.first) : Number.NaN;
  const last = range?.last ? Date.parse(range.last) : Number.NaN;
  if (Number.isFinite(first) && Number.isFinite(last)) {
    return historyWindow(first, last);
  }
  if (range || rangeFailed) {
    return historyWindow(now - FALLBACK_HISTORY_DAYS * DAY_MS, now);
  }
  return null;
};

/** The views of the location (floors, buildings, ...): its active Lageplans -
 * inactive ones are older versions. Without an active one, the newest. */
export const planViewsOf = (history: SensorHeatmapResponse | null): SensorHeatmapLageplanData[] => {
  const plans = history?.location?.lageplans;
  if (!Array.isArray(plans) || plans.length === 0) {
    return [];
  }
  const active = plans.filter((plan) => plan.is_active);
  return active.length > 0 ? active : [plans[0]];
};

/** The sensors of the shown view; points without a Lageplan of the views
 * (none set, or an old version) stay on the first view. */
export const viewPointsOf = (
  points: SensorHeatmapPoint[],
  planViews: SensorHeatmapLageplanData[],
  shown: SensorHeatmapLageplanData | null,
) => {
  if (planViews.length < 2 || !shown) {
    return points;
  }
  const viewIds = new Set(planViews.map((plan) => plan.id));
  const onFirstView = shown.id === planViews[0].id;
  return points.filter((point) =>
    point.lageplan != null && viewIds.has(point.lageplan)
      ? point.lageplan === shown.id
      : onFirstView,
  );
};

/** The heatmap of the shown view only: its plan and its sensors. */
export const viewHeatmapOf = (
  heatmap: SensorHeatmapResponse | null,
  planViews: SensorHeatmapLageplanData[],
  shown: SensorHeatmapLageplanData | null,
  viewPoints: SensorHeatmapPoint[],
): SensorHeatmapResponse | null => {
  if (!heatmap || planViews.length < 2 || !shown) {
    return heatmap;
  }
  return {
    ...heatmap,
    location: { ...heatmap.location, lageplans: [shown] },
    sensor_points: viewPoints,
  };
};

/**
 * smartex® dm: the sensors of one grid row are one line (a sensor run) -
 * drawn joined, listed as one table row and judged by their strongest
 * reading. Named after their common measure point name, else
 * `lineLabel(row)`. Sensors without a grid row are lines of their own.
 */
export const sensorLinesOf = (
  points: SensorHeatmapPoint[],
  lineLabel: (row: number) => string,
): SensorLine[] => {
  const rows = new Map<number, SensorHeatmapPoint[]>();
  const singles: SensorHeatmapPoint[] = [];
  points.forEach((point) => {
    if (point.grid_y == null) {
      singles.push(point);
    } else {
      rows.set(point.grid_y, [...(rows.get(point.grid_y) ?? []), point]);
    }
  });
  const commonName = (linePoints: SensorHeatmapPoint[]) => {
    const names = new Set(linePoints.map((point) => point.name || ''));
    return names.size === 1 ? [...names][0] || null : null;
  };
  return [
    ...[...rows.entries()]
      .sort(([a], [b]) => a - b)
      .map(([row, linePoints]) => ({
        key: `row-${row}`,
        label: commonName(linePoints) ?? lineLabel(row),
        points: [...linePoints].sort((a, b) => a.pos - b.pos),
      })),
    ...singles.map((point) => ({
      key: `single-${point.pos}`,
      label: point.name || `#${point.pos}`,
      points: [point],
    })),
  ];
};

/**
 * Points of LageplanZoneOverlay - sensor_points already carry the same
 * normalized x/y the heatmap markers use. With `lines`, the sensors of one
 * grid row are joined into one line; the value is the one of the shown frame,
 * else the newest.
 */
export const zonePointsOf = ({
  points,
  lines,
  heatmap,
  frameIndex,
  threshold,
}: {
  points: SensorHeatmapPoint[];
  /** Sensor lines; null when the plan doesn't join sensors into lines. */
  lines: SensorLine[] | null;
  heatmap: SensorHeatmapResponse | null;
  frameIndex: number | null;
  threshold: number | null;
}): LageplanZonePoint[] => {
  const lineOf = new Map(
    (lines ?? []).flatMap((line) => line.points.map((point) => [point.pos, line] as const)),
  );
  return points.map((point) => ({
    pos: point.pos,
    x: point.x,
    y: point.y,
    name: point.name ?? null,
    ...(lines
      ? {
          group: point.grid_y != null ? `row-${point.grid_y}` : null,
          groupLabel: lineOf.get(point.pos)?.label ?? null,
        }
      : {}),
    value: frameValue(heatmap, frameIndex, point.pos) ?? point.last_value ?? null,
    threshold: point.threshold ?? threshold,
    meters: measurePointMeters(point),
  }));
};

/** Per sensor of the heatmap: its newest and its highest value. */
export const sensorStatsOf = (heatmap: SensorHeatmapResponse | null): SensorStats => {
  const stats: SensorStats = new Map();
  Object.entries(heatmap?.data ?? {}).forEach(([key, series]) => {
    const values = (Array.isArray(series) ? series : [])
      .map(finiteValue)
      .filter((value): value is number => value != null);
    stats.set(key, { latest: values[values.length - 1] ?? null, max: highestOf(values) });
  });
  return stats;
};

/**
 * Rows of the sensor table, at the shown frame (else the newest value):
 * - lines (smartex® dm): one row per line, its strongest reading and the
 *   strictest threshold of its sensors;
 * - placed measure points: one row per sensor of the view, with its name
 *   and own threshold override;
 * - none placed yet: straight from the heatmap's series (a Lageplan without
 *   measure points still has devices reporting - #index is the best label).
 */
export const sensorRowsOf = ({
  heatmap,
  frameIndex,
  stats,
  hasMeasurePoints,
  points,
  lines,
  threshold,
}: {
  heatmap: SensorHeatmapResponse | null;
  frameIndex: number | null;
  stats: SensorStats;
  hasMeasurePoints: boolean;
  points: SensorHeatmapPoint[];
  lines: SensorLine[];
  threshold: number | null;
}): SensorListRow[] => {
  const valueOf = (key: string, fallback: number | null) =>
    frameIndex != null
      ? frameValue(heatmap, frameIndex, key)
      : (fallback ?? stats.get(key)?.latest ?? null);

  if (hasMeasurePoints && lines.length > 0) {
    return lines.map((line) => ({
      key: line.key,
      label: line.label,
      value: highestOf(line.points.map((point) => valueOf(String(point.pos), point.last_value ?? null))),
      max: highestOf(line.points.map((point) => stats.get(String(point.pos))?.max)),
      threshold: lowestOf(line.points.map((point) => point.threshold)) ?? threshold,
    }));
  }

  if (hasMeasurePoints) {
    return points.map((point) => {
      const key = String(point.pos);
      return {
        key,
        label: point.name || `#${point.pos}`,
        value: valueOf(key, point.last_value ?? null),
        max: stats.get(key)?.max ?? null,
        threshold: point.threshold ?? threshold,
      };
    });
  }

  return [...stats.keys()]
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => ({
      key,
      label: `#${key}`,
      value: valueOf(key, null),
      max: stats.get(key)?.max ?? null,
      threshold,
    }));
};

/**
 * Every sensor's measured values in the Zeitreihe; the sensors with a
 * Verdachtsstelle (resolved ones too) first and in colour, the others muted -
 * unless there is none, then all of them in colour.
 */
export const zeitreiheSeriesOf = (
  zeitreihe: Pick<SensorHeatmapResponse, 'timestamps' | 'data'> | null,
  clusters: VerdachtsstelleCluster[],
  labelOf: (sensorId: number) => string,
  thresholdOf: (sensorId: number) => number | null,
): ThresholdTrendSeries[] => {
  if (!zeitreihe) {
    return [];
  }
  const suspected = new Set(clusters.map((cluster) => cluster.sensor_id));
  const series = Object.keys(zeitreihe.data)
    .map(Number)
    .sort((a, b) => a - b)
    .map((sensorId) => ({
      id: `sensor-${sensorId}`,
      label: labelOf(sensorId),
      threshold: thresholdOf(sensorId),
      muted: suspected.size > 0 && !suspected.has(sensorId),
      points: (zeitreihe.data[sensorId] || []).map((value, index) => {
        const timestamp = zeitreihe.timestamps[index];
        return {
          id: `${sensorId}:${index}`,
          triggered_at: timestamp != null ? new Date(timestamp * 1000).toISOString() : null,
          value,
        };
      }),
    }));
  return [...series.filter((entry) => !entry.muted), ...series.filter((entry) => entry.muted)];
};

/** The Verdachtsstellen' latest alarm periods (until `now` while active),
 * marked on the plan's frame slider. `label` gets `to` null while active. */
export const alarmSpansOf = (
  clusters: VerdachtsstelleCluster[],
  now: number,
  label: (cluster: VerdachtsstelleCluster, from: number, to: number | null) => string,
): AlarmSpan[] =>
  clusters.flatMap((cluster) => {
    const from = cluster.since ? Date.parse(cluster.since) : Number.NaN;
    if (!Number.isFinite(from)) {
      return [];
    }
    const end = cluster.resolved_at ? Date.parse(cluster.resolved_at) : Number.NaN;
    const resolved = Number.isFinite(end);
    return [{
      key: cluster.id,
      from,
      to: resolved ? end : now,
      label: label(cluster, from, resolved ? end : null),
    }];
  });

/** Worst severity of the clusters; null without any. */
export const worstSeverityOf = (clusters: VerdachtsstelleCluster[]) =>
  clusters.reduce<Severity | null>(
    (worst, cluster) =>
      !worst || SEVERITY_ORDER[cluster.severity] > SEVERITY_ORDER[worst] ? cluster.severity : worst,
    null,
  );

/** Colour of the object status: by the worst open severity, green without. */
export const severityColor = (severity: Severity | null) =>
  severity ? SEVERITY_COLOR[severity] : NO_SEVERITY_COLOR;
