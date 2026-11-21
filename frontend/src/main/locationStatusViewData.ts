import { framesOf, seriesOf } from '../components/device/heatmapData';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import {
  defaultStepForRange,
  type HeatmapStep,
  type HeatmapWindow,
} from '../components/device/heatmapSteps';
import {
  type AnlageState,
  highestOf,
  type VerdachtsstelleCluster,
  worstSeverityOf,
} from './locationStatusData';
import { isTimeRange, type StatusRange, TIME_RANGE_DAYS } from './timeRanges';
import type { LiveMeasurements } from './useLocationLiveRevision';

/**
 * The status page's (LocationStatusView.tsx) own calculations - its range,
 * the plan's step, the KPIs, the measurement request's devices and the
 * live-update toast. Pure, see locationStatusViewData.spec.ts.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The days of what goes with a period (computed suspicion points, battery
 * chart): the latest measurement goes with the last 24 h. */
export const rangeDaysOf = (range: StatusRange) =>
  isTimeRange(range) ? TIME_RANGE_DAYS[range] : TIME_RANGE_DAYS['24h'];

/** The last `days` up to `now`, in frames of `step` seconds. */
export const rangeWindow = (
  now: number,
  days: number,
  step: number,
): HeatmapWindow => ({ from: now - days * DAY_MS, to: now, step });

// Points per Zeitreihe range at most (30 days hourly), each the highest
// value of its part of the range.
const ZEITREIHE_LIMIT = 720;

/** The plan's frames: "Letzte Messung"'s ten as loaded, else the window's,
 * cut out of the history. */
export const planFramesOf = (
  history: SensorHeatmapResponse | null,
  isLatest: boolean,
  window: HeatmapWindow,
) => (isLatest ? history : framesOf(history, window));

/** The Zeitreihe: "Letzte Messung"'s ten frames (the same the plan and its
 * table show), else the window's series, at most ZEITREIHE_LIMIT points. */
export const zeitreiheOf = (
  history: SensorHeatmapResponse | null,
  isLatest: boolean,
  { from, to }: Pick<HeatmapWindow, 'from' | 'to'>,
  baseStep: number | null,
) =>
  isLatest
    ? history
    : seriesOf(history, from, to, ZEITREIHE_LIMIT, baseStep ?? 30 * 60);

/** The plan's step: the picked one while the range offers it, else the
 * range's default. */
export const heatmapStepOf = (
  picked: number | null,
  options: readonly HeatmapStep[],
  days: number,
  baseStep: number | null,
) =>
  picked != null && options.some((step) => step.seconds === picked)
    ? picked
    : defaultStepForRange(days, baseStep);

/** A device that can be asked for a measurement (GET
 * /v1/location/<pk>/request-measurement/devices/). Only devices with a
 * chip_id are offered - the backend refuses the others. */
export type RequestableDevice = {
  id: number;
  display_name: string | null;
  /** The full name: custom name · model · hash (device_overview.device_label). */
  label?: string | null;
  chip_id: string | null;
  device_ip: string | null;
};

/** A measurement can only be requested from a device that identifies itself
 * (chip_id) and that has an address to reach (device_ip). */
export const requestableDevicesOf = (
  devices: readonly RequestableDevice[] | null | undefined,
): RequestableDevice[] =>
  (devices ?? []).filter(
    (device) => Boolean(device.chip_id) && Boolean(device.device_ip),
  );

/** The name a device is offered under in the request's dropdown. */
export const deviceLabelOf = (device: RequestableDevice) =>
  device.label || device.display_name || device.chip_id || `#${device.id}`;

/** The KPI strip's numbers: the worst open severity, the open
 * Verdachtsstellen (`openSuspicions` - the computed points - if given, else
 * one per open cluster) and the highest reading of all clusters. */
export const kpiSummaryOf = (
  clusters: readonly VerdachtsstelleCluster[],
  openSuspicions: number | null,
) => {
  const openClusters = clusters.filter(
    (cluster) => cluster.state !== 'geloest',
  );
  return {
    worstSeverity: worstSeverityOf(openClusters),
    openCount: openSuspicions ?? openClusters.length,
    highestReading: highestOf(clusters.map((cluster) => cluster.max_value)),
  };
};

/** The number of the points still open (not "geloest"). */
export const openCountOf = (points: readonly { state: string }[]) =>
  points.filter((point) => point.state !== 'geloest').length;

const ANLAGE_COLOR: Record<AnlageState, string> = {
  online: '#3F7A1C',
  offline: '#C44D26',
  unknown: '#8B8383',
  loading: '#8B8383',
};

/** Colour of the Anlage tile's value. */
export const anlageColor = (state: AnlageState) => ANLAGE_COLOR[state];

/** The toast for new measurements: its i18n key and options, and variant. */
export const liveMeasurementToast = ({
  count,
  alarm,
}: LiveMeasurements): {
  key: string;
  options?: { count: number };
  variant: 'warning' | 'info';
} => {
  const variant = alarm ? 'warning' : 'info';
  if (count === null) {
    // Found by the background check: how many is unknown.
    return { key: 'status_live_measurement_new', variant };
  }
  return {
    key: alarm ? 'status_live_measurement_alarm' : 'status_live_measurement',
    options: { count },
    variant,
  };
};
