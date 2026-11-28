/**
 * Pure state calculations of the Lageplan wizard (LageplanWizardView.tsx):
 * which plan a point sits on, what a server answer changes in the lists, the
 * request payloads and the messages shown. No React, no requests.
 */
import { getBackendUrl } from '../backendUrl';
import { isSmartexIoProject } from './projectType';
import {
  type MeasurePoint,
  type MeasurePointsResponse,
  planLabel,
  type PointSource,
  rotatedPoint,
  type WizardDevice,
  type WizardLageplan,
  type WizardLocation,
  type WizardSensor,
} from './lageplanWizardUtils';

/** The picked plan as the canvas (ImageCanvasStage) takes it. */
export type PlanSourceMeta = {
  fileName: string;
  imageUrl: string;
  offset_x: number;
  offset_y: number;
  scale_x: number;
  scale_y: number;
  flip_x: boolean;
  flip_y: boolean;
  reference_x: number | null;
  reference_y: number | null;
  meters_per_pixel: number | null;
};

/** The canvas' view of a plan - null without a plan image. */
export const planSourceMeta = (
  plan: WizardLageplan | null,
): PlanSourceMeta | null => {
  if (!plan?.url) {
    return null;
  }
  return {
    fileName: planLabel(plan),
    imageUrl: getBackendUrl(plan.url),
    offset_x: plan.offset_x ?? 0,
    offset_y: plan.offset_y ?? 0,
    scale_x: plan.scale_x ?? 1,
    scale_y: plan.scale_y ?? 1,
    flip_x: plan.flip_x ?? false,
    // Vertically flipped unless the plan says otherwise (the default of new plans).
    flip_y: plan.flip_y ?? true,
    reference_x: plan.reference_x ?? null,
    reference_y: plan.reference_y ?? null,
    meters_per_pixel: plan.meters_per_pixel ?? null,
  };
};

/** Whether a point / sensor (by its plan reference) sits on the plan:
 * without (a known) Lageplan it sits on the main plan - the same rule as the
 * status view's plan views. */
export const belongsToPlan = (
  planRef: unknown,
  planId: number | null,
  planIds: Set<number>,
  mainPlanId: number | null,
) => {
  const id = planRef == null ? null : Number(planRef);
  return id !== null && planIds.has(id) ? id === planId : planId === mainPlanId;
};

const listOrEmpty = <T>(value: T[] | null | undefined): T[] =>
  Array.isArray(value) ? value : [];

/** The lists of a measure_points answer - missing ones empty. */
export const measurePointsData = (data: MeasurePointsResponse | undefined) => ({
  points: listOrEmpty(data?.points),
  devices: listOrEmpty(data?.devices),
  plans: listOrEmpty(data?.lageplans),
});

/** The plan to work on after the plans loaded: the one ?plan= asks for,
 * else the picked one, else the main (first) one. */
export const nextSelectedPlanId = (
  plans: WizardLageplan[],
  wanted: number | null,
  current: number | null,
): number | null => {
  const has = (id: number | null) => plans.some((plan) => plan.id === id);
  const preselected = wanted != null && has(wanted) ? wanted : null;
  return preselected ?? (has(current) ? current : (plans[0]?.id ?? null));
};

/** Cut points as stored now - gone ones leave the clipboard. */
export const keptCutPoints = (cut: MeasurePoint[], points: MeasurePoint[]) =>
  cut.flatMap((cutPoint) =>
    points.filter((point) => Number(point.id) === Number(cutPoint.id)),
  );

/** The points a server answer carries ("points") - none when it has no list. */
export const answerPoints = (response: Record<string, unknown> | undefined) =>
  listOrEmpty(response?.points as MeasurePoint[] | undefined);

/** Points by id. */
export const pointsById = (points: MeasurePoint[]) =>
  new Map(points.map((point) => [Number(point.id), point]));

/** The points with those of the answer (by id) in their place. */
export const mergedPoints = (
  points: MeasurePoint[],
  byId: Map<number, MeasurePoint>,
) => points.map((point) => byId.get(Number(point.id)) ?? point);

/** The direction a plan image was turned by (edit_lageplan), or null. */
export const rotationOf = (response: Record<string, unknown> | undefined) =>
  response?.direction === 'cw' || response?.direction === 'ccw'
    ? { clockwise: response.direction === 'cw' }
    : null;

/** Unsaved sensors on a turned plan - turned like the stored points. */
export const rotatedSensors = (
  sensors: WizardSensor[],
  onPlan: (sensor: WizardSensor) => boolean,
  flipY: boolean,
  clockwise: boolean,
) =>
  sensors.map((sensor) => {
    if (!onPlan(sensor)) {
      return sensor;
    }
    const [nx, ny] = rotatedPoint(sensor.nx, sensor.ny, flipY, clockwise);
    return { ...sensor, nx, ny };
  });

/** The toast after the plan image was cropped or an area cleared. */
export const imageEditedMessage = (response: Record<string, unknown>) =>
  response?.message === 'Lageplan cropped.'
    ? 'Lageplan cropped and saved - the sensors kept their place.'
    : 'Area cleared and saved.';

/** The ids measure_points/remove reports as removed. */
export const removedPointIds = (response: Record<string, unknown>) =>
  new Set(
    (Array.isArray(response?.point_ids) ? response.point_ids : []).map(Number),
  );

/** The clipboard with newly cut points - a point cut again only once. */
export const withCutPoints = (
  current: MeasurePoint[],
  points: MeasurePoint[],
) => {
  const ids = new Set(points.map((point) => Number(point.id)));
  return [...current.filter((point) => !ids.has(Number(point.id))), ...points];
};

/** The toast after a JSON import (its answer is the uploaded file). */
export const jsonImportMessage = (response?: Record<string, unknown>) =>
  Array.isArray(response?.data)
    ? `${response.data.length} measure point(s) imported and saved.`
    : 'Measure points imported and saved.';

/** The dm sensors of an uploaded plan PDF (backend cad_import.import_dm_sensors). */
export type DmImport = {
  state: 'applied' | 'skipped' | 'failed';
  message: string;
  moved?: number;
  created?: number;
  sensors?: number;
  /** dm numbers whose band is unlike its neighbours in length - most off first. */
  length_outliers?: number[];
};

/** The toast after a plan upload - with what its dm sensors did. */
export const uploadMessage = (label: string, dmImport?: DmImport) => {
  const uploaded = `Lageplan "${label}" uploaded and selected.`;
  if (dmImport?.state === 'applied') {
    const placed = `${uploaded} ${dmImport.sensors ?? 0} dm sensor(s) placed on their bands (${dmImport.moved ?? 0} moved, ${dmImport.created ?? 0} new).`;
    const odd = dmImport.length_outliers ?? [];
    return odd.length
      ? `${placed} Check the length of ${odd.slice(0, 8).map((number) => `dm ${number}`).join(', ')}${odd.length > 8 ? ', …' : ''} - hold E and drag an end to fix it.`
      : placed;
  }
  if (dmImport?.state === 'failed') {
    return `${uploaded} The dm sensors could not be placed: ${dmImport.message}`;
  }
  return uploaded;
};

/** The toast after storing the scale. */
export const scaleSavedMessage = (metersPerPixel: number | null | undefined) =>
  metersPerPixel != null
    ? `Scale saved (${Number(metersPerPixel.toPrecision(4))} m per pixel).`
    : 'Reference point saved.';

/** A new upload heads the plans (it is active and the newest). */
export const plansWithUpload = (
  current: WizardLageplan[],
  plan: WizardLageplan,
) => [plan, ...current.filter((existing) => existing.id !== plan.id)];

/** Points imported (CAD/JSON/TXT) go onto the picked Lageplan, replacing
 * only the points on it (cad_import.store_measure_points) - without one, onto
 * the main plan - each on the device whose inputs measure it (step 8). */
export const importPayloadFor = (locationId: number | null, planId: number | null) => ({
  location_id: locationId,
  ...(planId !== null ? { lageplan_id: planId } : {}),
});

/** The canvas' heading: what it shows of the picked plan. */
export const canvasTitle = ({
  manual,
  lines,
  sensorCount,
  pointCount,
}: {
  manual: boolean;
  lines: boolean;
  sensorCount: number;
  pointCount: number;
}) => {
  if (manual) {
    return `${sensorCount} sensor(s) placed on this plan`;
  }
  return lines
    ? `${pointCount} dm sensor(s) on this plan`
    : `${pointCount} measure point(s) on this plan`;
};

/** How many points carry a band end (dm sensors read from the plan). */
export const bandCount = (points: MeasurePoint[]) =>
  points.filter((point) => point.nx_end != null && point.ny_end != null).length;

/** The sensors with one placed - replacing the device's earlier place. */
export const withPlacedSensor = (
  sensors: WizardSensor[],
  placed: WizardSensor,
) =>
  sensors.some((sensor) => sensor.deviceId === placed.deviceId)
    ? sensors.map((sensor) =>
        sensor.deviceId === placed.deviceId ? placed : sensor,
      )
    : [...sensors, placed];

/** The next device without a point after the active one, or null. */
export const nextUnplacedDeviceId = (
  devices: WizardDevice[],
  activeId: number,
  placedIds: Set<number>,
) =>
  devices.find((device) => device.id !== activeId && !placedIds.has(device.id))
    ?.id ?? null;

/** The points the manual placement stores (measure_points POST). */
export const manualSensorsPayload = (sensors: WizardSensor[]) =>
  sensors.map((sensor) => ({
    x: Number(sensor.nx.toFixed(6)),
    y: Number(sensor.ny.toFixed(6)),
    device_id: sensor.deviceId,
    // Without one the point keeps its plan (see measure_points POST).
    lageplan_id: sensor.lageplanId ?? undefined,
  }));

/** The plans with the one at `index` moved by `delta` - null out of range. */
export const swappedPlans = (
  plans: WizardLageplan[],
  index: number,
  delta: -1 | 1,
) => {
  const target = index + delta;
  if (target < 0 || target >= plans.length) {
    return null;
  }
  const reordered = [...plans];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  return reordered;
};

/** Points without a plan tied to `planId` (the old main plan). */
export const pointsTiedTo = (points: MeasurePoint[], planId: number) =>
  points.map((point) =>
    point.lageplan == null ? { ...point, lageplan: planId } : point,
  );

/** Sensors without a plan tied to `planId` (the old main plan). */
export const sensorsTiedTo = (sensors: WizardSensor[], planId: number) =>
  sensors.map((sensor) =>
    sensor.lageplanId == null ? { ...sensor, lageplanId: planId } : sensor,
  );

/** The query string naming the location (?plan= dropped, the rest kept) -
 * null when it would not change. */
export const locationSearch = (search: string, locationId: number | null) => {
  const params = new URLSearchParams(search);
  if (locationId != null) {
    params.set('location', String(locationId));
  } else {
    params.delete('location');
  }
  params.delete('plan');
  if (params.toString() === new URLSearchParams(search).toString()) {
    return null;
  }
  return params.toString() ? `?${params}` : '';
};

/** How a location's points are set at first: by hand for smartex io projects. */
export const pointSourceFor = (location: WizardLocation | null): PointSource =>
  location && isSmartexIoProject(location.project_type) ? 'manual' : 'cad';

/** The plan ?plan=<lageplan id> asks for (e.g. from /analyse), or null. */
export const requestedPlanId = (searchParams: URLSearchParams) =>
  Number(searchParams.get('plan')) || null;
