/**
 * Time ranges of the location views - the Zeitreihe toggle in
 * LocationStatusView and the climate charts in LocationClimatePanels. The
 * short ranges are always offered; the long ones only once the location's
 * measurements actually reach that far back (GET .../measurement-range/).
 */

export type TimeRange = '24h' | '7d' | '30d' | '1y' | '3y';

export const TIME_RANGE_DAYS: Record<TimeRange, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '1y': 365,
  '3y': 1095,
};

/** Always offered - also while the measurement range is loading or failed. */
export const SHORT_TIME_RANGES: readonly TimeRange[] = ['24h', '7d', '30d'];

/** Offered once the data spans more than `minSpanDays` (now - first). */
const LONG_TIME_RANGES: readonly { range: TimeRange; minSpanDays: number }[] = [
  { range: '1y', minSpanDays: 30 },
  { range: '3y', minSpanDays: 365 },
];

/** GET /v1/location/<pk>/measurement-range/ (and /v1/demo/<pk>/...). */
export type MeasurementRange = {
  /** Oldest measurement time (ISO), null without measurements. */
  first: string | null;
  /** Newest measurement time (ISO), null without measurements. */
  last: string | null;
  count: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** i18n key of a range's toggle label. */
export const timeRangeLabelKey = (range: TimeRange) => `status_range_${range}`;

/**
 * The ranges to offer, shortest first: the short ones always, '1y' when the
 * data spans more than 30 days and '3y' when it spans more than a year.
 * Without a (valid) measurement range only the short ones.
 */
export const availableTimeRanges = (
  measurementRange: MeasurementRange | null | undefined,
  now: number = Date.now(),
): TimeRange[] => {
  const first = measurementRange?.first
    ? new Date(measurementRange.first).getTime()
    : Number.NaN;
  if (!Number.isFinite(first)) {
    return [...SHORT_TIME_RANGES];
  }
  const spanDays = (now - first) / DAY_MS;
  return [
    ...SHORT_TIME_RANGES,
    ...LONG_TIME_RANGES.filter((entry) => spanDays > entry.minSpanDays).map(
      (entry) => entry.range,
    ),
  ];
};

/** The selected range if it is offered, otherwise the longest offered one. */
export const effectiveTimeRange = (
  selected: TimeRange,
  available: readonly TimeRange[],
): TimeRange => {
  if (available.length === 0 || available.includes(selected)) {
    return selected;
  }
  return available.reduce((longest, range) =>
    TIME_RANGE_DAYS[range] > TIME_RANGE_DAYS[longest] ? range : longest,
  );
};

/** i18n key (+ count) describing what one averaged point stands for. */
export type BucketLabel = { key: string; count: number };

const MINUTE_S = 60;
const HOUR_S = 60 * MINUTE_S;
const DAY_S = 24 * HOUR_S;

/**
 * Label for the bucket size of aggregated climate data ("daily averages",
 * "6-hour averages", ...); null for raw data (no or invalid bucket size).
 */
export const bucketLabel = (
  bucketSeconds: number | null | undefined,
): BucketLabel | null => {
  if (
    bucketSeconds == null ||
    !Number.isFinite(bucketSeconds) ||
    bucketSeconds <= 0
  ) {
    return null;
  }
  if (bucketSeconds % DAY_S === 0) {
    const days = bucketSeconds / DAY_S;
    if (days === 1) {
      return { key: 'climate_bucket_daily', count: 1 };
    }
    if (days === 7) {
      return { key: 'climate_bucket_weekly', count: 1 };
    }
    return { key: 'climate_bucket_days', count: days };
  }
  if (bucketSeconds >= HOUR_S) {
    const hours = Math.round(bucketSeconds / HOUR_S);
    if (hours === 1) {
      return { key: 'climate_bucket_hourly', count: 1 };
    }
    return { key: 'climate_bucket_hours', count: hours };
  }
  return {
    key: 'climate_bucket_minutes',
    count: Math.max(1, Math.round(bucketSeconds / MINUTE_S)),
  };
};
