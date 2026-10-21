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
export const PROJECT_TYPE_LORAWAN = 6;

export const isLorawanProject = (value: number | null | undefined): boolean =>
  value === PROJECT_TYPE_LORAWAN;

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
