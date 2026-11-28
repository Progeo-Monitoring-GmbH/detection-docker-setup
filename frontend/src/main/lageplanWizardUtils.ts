import type { PickableLocation } from '../components/location/LocationPicker';
import type { PlacedSensor } from '../components/ui/ImageCanvasStage';
import type { SensorHeatmapLageplanData } from '../components/device/sensorHeatmapTypes';

export type ImportedCad = {
  location_id: number;
  lageplan_id?: number | null;
  stored: number;
  points: Array<Record<string, unknown>>;
  warning?: string | null;
};

export type WizardDevice = {
  id: number;
  mac?: string | null;
  hardware?: string | null;
  type?: string | null;
  raw_hash?: string | null;
  first_sensor_order?: number | null;
  /** Saved with a range's "to" (measure_points/device_ranges); null: open. */
  sensor_count?: number | null;
};

export type WizardLageplan = SensorHeatmapLageplanData & { id: number };
export type MeasurePoint = Record<string, unknown>;

export type MeasurePointsResponse = {
  points?: MeasurePoint[];
  lageplans?: WizardLageplan[] | null;
  devices?: WizardDevice[];
};

export type WizardLocation = PickableLocation & {
  project_id: number;
  project_type?: number | null;
};

export type WizardSensor = PlacedSensor & { lageplanId: number | null };
export type PointSource = 'cad' | 'json' | 'txt' | 'manual';

export type WizardConfirmAction =
  { kind: 'plan'; plan: WizardLageplan } | { kind: 'points' };

export const POINT_SOURCES: Array<{ value: PointSource; label: string }> = [
  { value: 'cad', label: 'CAD (DWG/DXF)' },
  { value: 'json', label: 'JSON' },
  { value: 'txt', label: 'TXT' },
  { value: 'manual', label: 'Manually set sensors' },
];

/** A measure point's normalized position after its plan turned by 90 degrees. */
export const rotatedPoint = (
  nx: number,
  ny: number,
  flipY: boolean,
  clockwise: boolean,
): [number, number] => {
  const v = flipY ? 1 - ny : ny;
  const [nextNx, nextV] = clockwise ? [1 - v, nx] : [v, 1 - nx];
  return [nextNx, flipY ? 1 - nextV : nextV];
};

export const getFileExt = (name: string) =>
  name.split('.').pop()?.toLowerCase() ?? '';

/** Devices are shown by their MAC; without one by hardware name / hash. */
export const deviceLabel = (device: WizardDevice) =>
  device.mac || device.hardware || device.raw_hash || `#${device.id}`;

export const planLabel = (plan: WizardLageplan) =>
  plan.name || plan.url?.split('/').pop() || `Lageplan #${plan.id}`;

/** Whether the plan's points were moved/scaled away from the defaults. */
export const isAligned = (plan: WizardLageplan) =>
  Boolean(plan.offset_x || plan.offset_y) ||
  (plan.scale_x ?? 1) !== 1 ||
  (plan.scale_y ?? 1) !== 1;

const pointsPerDevice = (points: MeasurePoint[]) => {
  const counts = new Map<number, number>();
  points.forEach((point) => {
    if (point.device != null) {
      const deviceId = Number(point.device);
      counts.set(deviceId, (counts.get(deviceId) ?? 0) + 1);
    }
  });
  return counts;
};

/** The hand-placed sensors among stored points (in sensor order). */
export const placedFromPoints = (
  points: MeasurePoint[],
  devices: WizardDevice[],
): WizardSensor[] => {
  const counts = pointsPerDevice(points);
  return points
    .filter(
      (point) => point.device != null && counts.get(Number(point.device)) === 1,
    )
    .sort((a, b) => Number(a.sensor_order) - Number(b.sensor_order))
    .map((point) => {
      const deviceId = Number(point.device);
      const device = devices.find((candidate) => candidate.id === deviceId);
      return {
        deviceId,
        label: device ? deviceLabel(device) : `#${deviceId}`,
        nx: Number(point.nx),
        ny: Number(point.ny),
        lageplanId: point.lageplan == null ? null : Number(point.lageplan),
      };
    });
};

export const requestReason = (requestError: unknown) =>
  (requestError as { response?: { data?: { reason?: string } } })?.response
    ?.data?.reason ?? (requestError as Error).message;
