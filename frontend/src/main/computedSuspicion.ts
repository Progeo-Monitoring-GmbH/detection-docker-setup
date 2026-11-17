/**
 * smartex® mx-PEEL: computed suspicion points ("berechnete
 * Verdachtsstellen") - the over-threshold sensors of the selected range
 * aggregated into the places a leak most likely is (backend:
 * /v1/alarm/computed-clusters/, helper/suspicion_clusters.py, concept in
 * docs/mx_peel_suspicion_points.md). Pure helpers - the hook is
 * useComputedSuspicion, the list ComputedSuspicionPanel, the markers on the
 * plan components/device/SuspicionMarkers.
 */
import type { SuspicionPlanMarker } from '../components/device/SuspicionMarkers';
import type { Severity } from '../components/ui/kit/SeverityBadge';
import type { AlarmState } from '../components/ui/kit/StateBadge';

/** ProgeoLocation.PROJECT_TYPE_CHOICES: smartex® mx-PEEL. */
export const PROJECT_TYPE_MX_PEEL = 7;

export const usesComputedSuspicion = (projectType: number | null | undefined) =>
  projectType === PROJECT_TYPE_MX_PEEL;

/** One computed point, as /v1/alarm/computed-clusters/ answers it. */
export type ComputedSuspicionPoint = {
  id: string;
  /** Normalized position - the coordinates of the heatmap's sensor_points. */
  x: number;
  y: number;
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
};

/** What the Status tab shows for an mx-PEEL object: the computed points or
 * the per-sensor Verdachtsstellen (staff can switch). */
export type SuspicionMode = 'computed' | 'sensors';

/** Customers always see the computed points; staff pick. */
export const effectiveSuspicionMode = (
  isMxPeel: boolean,
  isStaff: boolean,
  picked: SuspicionMode,
): SuspicionMode | null => (isMxPeel ? (isStaff ? picked : 'computed') : null);

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

/** The markers of the points on the plan: lettered as in the list. */
export const suspicionMarkersOf = (
  points: ComputedSuspicionPoint[],
): SuspicionPlanMarker[] =>
  points.map((point, index) => ({
    id: point.id,
    x: point.x,
    y: point.y,
    lageplan: point.lageplan,
    label: pointLetter(index),
    state: point.state,
    strength: point.strength,
  }));

/** The markers on the shown view (Lageplan) - those of no plan on every view. */
export const suspicionsOnPlan = (
  markers: SuspicionPlanMarker[] | undefined,
  planId: number | null,
): SuspicionPlanMarker[] | undefined =>
  markers?.filter(
    (marker) => marker.lageplan == null || marker.lageplan === planId,
  );

/** The URL of the points for a location and range. */
export const computedSuspicionUrl = (
  locationId: number,
  days: number,
  demo: boolean,
) =>
  demo
    ? `/v1/demo/alarm-computed-clusters/?location=${locationId}&days=${days}`
    : `/v1/alarm/computed-clusters/?location=${locationId}&days=${days}`;
