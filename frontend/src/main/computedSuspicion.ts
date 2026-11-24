/**
 * Computed suspicion points ("berechnete Verdachtsstellen", every product -
 * mx-PEEL needed them first) - the over-threshold sensors of the selected range
 * aggregated into the places a leak most likely is (backend:
 * /v1/alarm/computed-clusters/, helper/suspicion_clusters.py, concept in
 * docs/mx_peel_suspicion_points.md). Pure helpers - the hook is
 * useComputedSuspicion, the list ComputedSuspicionPanel, the markers on the
 * plan components/device/SuspicionMarkers.
 */
import type { SuspicionPlanMarker } from '../components/device/SuspicionMarkers';
import type { Severity } from '../components/ui/kit/SeverityBadge';
import type { AlarmState } from '../components/ui/kit/StateBadge';

/** One line of an "Alarm-Verlauf": a reading of an over-threshold sensor. */
export type AlarmHistoryEntry = {
  id: number | string;
  triggered_at: string | null;
  value: number | null;
  state: AlarmState;
  /** The sensor - set in a computed point's history (several sensors). */
  sensor_id?: number;
};

/** One computed point, as /v1/alarm/computed-clusters/ answers it. */
export type ComputedSuspicionPoint = {
  id: string;
  /** Normalized position - the coordinates of the heatmap's sensor_points;
   * null: the sensor isn't placed on a Lageplan (a point of its own, no ring). */
  x: number | null;
  y: number | null;
  /** The Lageplan (view) it lies on. */
  lageplan: number | null;
  /** 0..1 of the plan's strongest point. */
  strength: number;
  sensor_ids: number[];
  state: AlarmState;
  active: boolean;
  severity: Severity | null;
  max_value: number | null;
  max_exceedance: number | null;
  first_seen: string | null;
  last_seen: string | null;
  readings: number;
  alarm_ids: number[];
  pending_ack_alarm_ids: number[];
  /** Position in metres on a calibrated plan. */
  x_m: number | null;
  y_m: number | null;
  /** The member sensors' alarm history, newest first. */
  alarms: AlarmHistoryEntry[];
};

/** What the Status tab shows: the computed points or the per-sensor
 * Verdachtsstellen (staff can switch). */
export type SuspicionMode = 'computed' | 'sensors';

/** Customers always see the computed points; staff pick. */
export const effectiveSuspicionMode = (
  isStaff: boolean,
  picked: SuspicionMode,
): SuspicionMode => (isStaff ? picked : 'computed');

/** "A", "B", ... "Z", "AA", ... - the letter of the n-th point (0-based),
 * the same on the plan and in the list. */
export const pointLetter = (index: number): string => {
  let rest = index;
  let letter = '';
  do {
    letter = String.fromCharCode(65 + (rest % 26)) + letter;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return letter;
};

/** The member sensors, short: "12, 13, 15" - at most `limit`, then "+n". */
export const sensorList = (
  sensorIds: number[],
  label: (id: number) => string,
  limit = 4,
) => {
  const shown = sensorIds.slice(0, limit).map(label);
  const more = sensorIds.length - shown.length;
  return more > 0 ? `${shown.join(', ')} +${more}` : shown.join(', ');
};

/** The markers of the points on the plan: lettered as in the list - a
 * point of an unplaced sensor keeps its letter but has no ring. */
export const suspicionMarkersOf = (
  points: ComputedSuspicionPoint[],
): SuspicionPlanMarker[] =>
  points.flatMap((point, index) =>
    point.x == null || point.y == null
      ? []
      : [
          {
            id: point.id,
            x: point.x,
            y: point.y,
            lageplan: point.lageplan,
            label: pointLetter(index),
            state: point.state,
            strength: point.strength,
            seenFrom: momentOf(point.first_seen),
            seenUntil: momentOf(point.last_seen),
          },
        ],
  );

/** The markers on the shown view (Lageplan) - those of no plan on every view. */
export const suspicionsOnPlan = (
  markers: SuspicionPlanMarker[] | undefined,
  planId: number | null,
): SuspicionPlanMarker[] | undefined =>
  markers?.filter(
    (marker) => marker.lageplan == null || marker.lageplan === planId,
  );

/** An ISO-8601 moment as ms - null without one or when unreadable. */
const momentOf = (iso: string | null | undefined) => {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The markers detected in the shown frame: a frame holds the time from its
 * start to the next frame's (`timestamps` in seconds, as the heatmap's; the
 * newest one up to now) - a marker shows while that overlaps its detection
 * (seenFrom..seenUntil). Without a detection time a marker always shows;
 * without frames (or none picked) all do.
 */
export const suspicionsAtFrame = (
  markers: SuspicionPlanMarker[] | undefined,
  timestamps: number[] | undefined,
  frameIndex: number | null,
): SuspicionPlanMarker[] | undefined => {
  const start = frameIndex != null ? timestamps?.[frameIndex] : undefined;
  if (!markers || timestamps == null || start == null) {
    return markers;
  }
  const next = timestamps[(frameIndex ?? 0) + 1];
  const from = start * 1000;
  const until = next != null ? next * 1000 : Number.POSITIVE_INFINITY;
  return markers.filter((marker) => {
    if (marker.seenFrom == null) {
      return true;
    }
    return (
      marker.seenFrom < until && (marker.seenUntil ?? marker.seenFrom) >= from
    );
  });
};

/** The URL of the points for a location and range. */
export const computedSuspicionUrl = (
  locationId: number,
  days: number,
  demo: boolean,
) =>
  demo
    ? `/v1/demo/alarm-computed-clusters/?location=${locationId}&days=${days}`
    : `/v1/alarm/computed-clusters/?location=${locationId}&days=${days}`;
