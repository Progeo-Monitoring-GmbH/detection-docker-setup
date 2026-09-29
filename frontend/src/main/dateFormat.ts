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

/** ms -> naive local ISO string (matches the backend from/to params). */
export const toLocalIso = (ms: number): string => {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
};
