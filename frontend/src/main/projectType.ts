import type { DeviceKind, LocationDetail } from './locationTypes';

// Mirrors ProgeoLocation.PROJECT_TYPE_CHOICES (progeo/v1/models.py) - a fixed
// Django IntegerChoices enum, safe to hardcode client-side for display.
// Brand/product names (smartex® dm/is/..., geologger) stay literal; the generic
// terms go through i18n. Shared by LocationObjektTab (editable dropdown,
// backed by GET /v1/location/project-types/) and LocationStatusView (a
// read-only label in the page header).
export const PROJECT_TYPE_LABEL_KEYS: Record<number, string> = {
  0: 'objekt_project_type_unknown',
  4: 'objekt_project_type_development',
  5: 'objekt_project_type_versuchsprojekte',
  99: 'objekt_project_type_sonstige',
};

export const PROJECT_TYPE_BRAND_LABELS: Record<number, string> = {
  1: 'smartex® dm',
  2: 'geologger',
  3: 'smartex® is',
  7: 'smartex® mx-PEEL',
  8: 'smartex® mx-va',
  9: 'smartex® mx-al',
  10: 'smartex® io',
  11: 'smartex® vt',
};

// smartex io objects (LoRaWAN radio and RS485 climate sensors - formerly the
// project type 6 "LoRaWan") report humidity/temperature per device instead
// of samples, so they get climate charts instead of the heatmap.
const PROJECT_TYPE_SMARTEX_IO = 10;

export const isSmartexIoProject = (value: number | null | undefined): boolean =>
  value === PROJECT_TYPE_SMARTEX_IO;

const LEAK_ONLY: readonly DeviceKind[] = ['leak'];
const CLIMATE_ONLY: readonly DeviceKind[] = ['climate'];

/** The device kinds of a location - the tabs of its status and analysis
 * pages: what the detail answer says (device_kinds), else by the product
 * (smartex io: climate, everything else leak). */
export const deviceKindsOf = (
  location: Pick<LocationDetail, 'device_kinds' | 'project_type'> | null | undefined,
): readonly DeviceKind[] => {
  if (location?.device_kinds?.length) {
    return location.device_kinds;
  }
  return isSmartexIoProject(location?.project_type) ? CLIMATE_ONLY : LEAK_ONLY;
};

/**
 * How the Status tab draws a product's sensors on the Lageplan: the
 * Gaussian heat field (SensorHeatmap2D) or one of LageplanZoneOverlay's
 * modes - lines (one run of sensors per grid row), segments (one filled
 * area per named zone) or points - or, without a plan, one status tile per
 * sensor (SensorStatusTiles, the "Sensoransicht" - also every product's
 * view while its location has no Lageplan).
 */
export type PlanVisualization = 'heatmap' | 'lines' | 'segments' | 'points' | 'tiles';

const PLAN_VISUALIZATIONS: Record<number, PlanVisualization> = {
  1: 'lines', // smartex® dm
  3: 'tiles', // smartex® is
  7: 'heatmap', // smartex® mx-PEEL
  8: 'segments', // smartex® mx-va
  9: 'segments', // smartex® mx-al
  11: 'points', // smartex® vt
  // smartex® io has no samples - its climate panels draw the plan themselves.
};

export const planVisualization = (value: number | null | undefined): PlanVisualization =>
  (value != null && PLAN_VISUALIZATIONS[value]) || 'heatmap';

// Products listing every sensor (with its optional name) below the plan.
const SENSOR_TABLE_TYPES = new Set([1, 11]);

export const showsSensorTable = (value: number | null | undefined): boolean =>
  value != null && SENSOR_TABLE_TYPES.has(value);

export const getProjectTypeLabel = (
  t: (key: string) => string,
  value: number | null | undefined,
  fallbackLabel?: string | null,
): string => {
  if (value == null) {
    return '–';
  }
  return (
    PROJECT_TYPE_BRAND_LABELS[value] ??
    (PROJECT_TYPE_LABEL_KEYS[value] ? t(PROJECT_TYPE_LABEL_KEYS[value]) : (fallbackLabel ?? String(value)))
  );
};
