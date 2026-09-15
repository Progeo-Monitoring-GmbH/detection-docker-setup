// Mirrors ProgeoLocation.PROJECT_TYPE_CHOICES (progeo/v1/models.py) - a fixed
// Django IntegerChoices enum, safe to hardcode client-side for display.
// Brand/product names (smartex, geologger, DFH) stay literal; the generic
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
  1: 'smartex',
  2: 'geologger',
  3: 'DFH',
};

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
