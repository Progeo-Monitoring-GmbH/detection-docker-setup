/**
 * Some historic rows have unparseable date strings (confirmed by the
 * `ageInfoFromDate` NaN-guard already used in LocationsMapView.jsx) - a bare
 * `new Date(value).toLocaleString()` then renders the literal text
 * "Invalid Date" to the user instead of a placeholder.
 */
export const formatDateTime = (value?: string | null): string => {
  if (!value) {
    return '–';
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '–' : parsed.toLocaleString();
};
