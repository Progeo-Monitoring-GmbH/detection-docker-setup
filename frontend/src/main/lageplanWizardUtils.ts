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

export type DeviceRange = { deviceId: number | null; from: string; to: string };
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

/** The device ranges step 2 shows: each device with imported points (more
 * than one - a single one is a hand-placed sensor) from its first sensor to
 * its last point, and each device whose saved range starts behind sensor 1
 * (measure_points/device_ranges) - also without points yet, ending at its
 * saved sensor count. The last range is open-ended unless its end was saved. */
export const defaultDeviceRanges = (
  points: MeasurePoint[],
  devices: WizardDevice[],
): DeviceRange[] => {
  const counts = pointsPerDevice(points);
  const ranges = devices
    .flatMap((device) => {
      const orders = points
        .filter((point) => Number(point.device) === device.id)
        .map((point) => Number(point.sensor_order));
      const saved = (device.first_sensor_order ?? 1) > 1;
      if ((counts.get(device.id) ?? 0) <= 1 && !saved) {
        return [];
      }
      const from = device.first_sensor_order ?? Math.min(...orders);
      // A saved range without points ends where its sensor count says (or nowhere).
      const savedEnd = orders.length === 0;
      const to = savedEnd
        ? device.sensor_count != null ? String(from + device.sensor_count - 1) : ''
        : String(Math.max(...orders));
      return [{ range: { deviceId: device.id, from: String(from), to }, savedEnd }];
    })
    .sort((a, b) => Number(a.range.from) - Number(b.range.from));
  if (ranges.length) {
    const last = ranges[ranges.length - 1];
    if (!last.savedEnd) {
      last.range.to = '';
    }
    return ranges.map(({ range }) => range);
  }
  return devices.length === 1
    ? [{ deviceId: devices[0].id, from: '1', to: '' }]
    : [];
};

/** Why the ranges can't be imported, or null. */
export const rangesProblem = (ranges: DeviceRange[]): string | null => {
  const used = ranges.filter((range) => range.deviceId != null);
  if (new Set(used.map((range) => range.deviceId)).size !== used.length) {
    return 'Each device only once - its pair 1 is the first sensor of its range.';
  }
  const parsed = used
    .map((range) => ({
      from: range.from.trim() ? Number(range.from) : 1,
      to: range.to.trim() ? Number(range.to) : Infinity,
    }))
    .sort((a, b) => a.from - b.from);
  if (
    parsed.some(
      (range) =>
        !Number.isInteger(range.from) ||
        range.from < 1 ||
        range.to < range.from,
    )
  ) {
    return 'The sensors of a device run from 1 up (from <= to).';
  }
  if (
    parsed.some(
      (range, index) => index > 0 && parsed[index - 1].to >= range.from,
    )
  ) {
    return 'The ranges of two devices overlap.';
  }
  return null;
};

export const requestReason = (requestError: unknown) =>
  (requestError as { response?: { data?: { reason?: string } } })?.response
    ?.data?.reason ?? (requestError as Error).message;
