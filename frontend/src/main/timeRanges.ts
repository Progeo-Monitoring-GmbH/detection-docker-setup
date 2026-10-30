/**
 * Time ranges of the location views - the Zeitreihe toggle in
 * LocationStatusView, the climate charts in LocationClimatePanels and the
 * Analyse tab. A view names its candidate ranges (timeRangeCandidates); of
 * those only the ones the location's measurements actually fill are offered
 * (GET .../measurement-range/, availableTimeRanges).
 */

export type TimeRange = '24h' | '7d' | '30d' | '90d' | '180d' | '1y' | '3y';

export const TIME_RANGE_DAYS: Record<TimeRange, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '180d': 180,
  '1y': 365,
  '3y': 1095,
};

/** Every view offers these (as far as the data reaches). */
export const SHORT_TIME_RANGES: readonly TimeRange[] = ['24h', '7d', '30d'];

/** The long ranges of the Status view and the climate charts. */
const LONG_TIME_RANGES: readonly TimeRange[] = ['1y', '3y'];

/** Staff (and superusers) additionally: last quarter, half year and year. */
const STAFF_TIME_RANGES: readonly TimeRange[] = ['90d', '180d', '1y'];

/** A view's candidate ranges, shortest first: the short ones, `long` adds
 * 1y/3y, `staff` the quarter, half year and year. */
export const timeRangeCandidates = ({
  long = false,
  staff = false,
}: { long?: boolean; staff?: boolean } = {}): TimeRange[] =>
  (Object.keys(TIME_RANGE_DAYS) as TimeRange[]).filter(
    (range) =>
      SHORT_TIME_RANGES.includes(range) ||
      (long && LONG_TIME_RANGES.includes(range)) ||
      (staff && STAFF_TIME_RANGES.includes(range)),
  );

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
 * The `candidates` to offer, shortest first: the shortest always, every
 * longer one only once the data spans more than the candidate before it - it
 * would show nothing the shorter one doesn't (no "last 30 days" for a week of
 * data). Without measurements only the shortest; while the measurement range
 * is unknown (loading, failed, unparsable) the short ones.
 */
export const availableTimeRanges = (
  measurementRange: MeasurementRange | null | undefined,
  candidates: readonly TimeRange[] = timeRangeCandidates({ long: true }),
  now: number = Date.now(),
): TimeRange[] => {
  if (measurementRange && !measurementRange.first) {
    return candidates.slice(0, 1);
  }
  const first = measurementRange?.first
    ? new Date(measurementRange.first).getTime()
    : Number.NaN;
  if (!Number.isFinite(first)) {
    return candidates.filter((range) => SHORT_TIME_RANGES.includes(range));
  }
  const spanDays = (now - first) / DAY_MS;
  return candidates.filter(
    (_range, index) => index === 0 || spanDays > TIME_RANGE_DAYS[candidates[index - 1]],
  );
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
