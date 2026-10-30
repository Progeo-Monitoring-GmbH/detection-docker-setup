// Mirrors ProgeoLocation.PROJECT_TYPE_CHOICES (progeo/v1/models.py) - a fixed
// Django IntegerChoices enum, safe to hardcode client-side for display.
// Brand/product names (smartex® dm/is/..., geologger, LoRaWan) stay literal; the generic
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
  6: 'LoRaWan',
  7: 'smartex® mx-PEEL',
  8: 'smartex® mx-va',
  9: 'smartex® mx-al',
  10: 'smartex® io',
  11: 'smartex® vt',
};

// LoRaWAN objects report humidity/temperature per device instead of
// samples, so they get climate charts instead of the heatmap.
const PROJECT_TYPE_LORAWAN = 6;

export const isLorawanProject = (value: number | null | undefined): boolean =>
  value === PROJECT_TYPE_LORAWAN;

/**
 * How the Status tab draws a product's sensors on the Lageplan: the
 * Gaussian heat field (SensorHeatmap2D) or one of LageplanZoneOverlay's
 * modes - lines (one run of sensors per grid row), segments (one filled
 * area per named zone) or points.
 */
export type PlanVisualization = 'heatmap' | 'lines' | 'segments' | 'points';

const PLAN_VISUALIZATIONS: Record<number, PlanVisualization> = {
  1: 'lines', // smartex® dm
  3: 'segments', // smartex® is
  7: 'heatmap', // smartex® mx-PEEL
  8: 'segments', // smartex® mx-va
  9: 'segments', // smartex® mx-al
  10: 'points', // smartex® io
  11: 'points', // smartex® vt
};

export const planVisualization = (value: number | null | undefined): PlanVisualization =>
  (value != null && PLAN_VISUALIZATIONS[value]) || 'heatmap';

// Products listing every sensor (with its optional name) below the plan.
const SENSOR_TABLE_TYPES = new Set([1, 10, 11]);

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
