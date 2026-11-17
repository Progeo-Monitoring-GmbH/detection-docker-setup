import { TIME_RANGE_DAYS, type TimeRange } from './timeRanges';

/**
 * `/location/<id>/status?at=<ISO-8601>`: the Status view opened at a moment -
 * e.g. from an event of the notification history. The heatmap gets a range
 * that contains it and starts at the frame holding it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A moment this far in the future still counts (clocks differ a little). */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** The `at` parameter as epoch ms - null when missing, unparsable or in the future. */
export const parseStatusAt = (raw: string | null | undefined, now: number = Date.now()): number | null => {
  if (!raw) {
    return null;
  }
  // ISO-8601 only (a date, optionally with time) - Date.parse also takes
  // other formats, which differ between browsers.
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(raw.trim())) {
    return null;
  }
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms) || ms > now + FUTURE_TOLERANCE_MS) {
    return null;
  }
  return ms;
};

/** Share of a range `at` may lie back at most - the first frame starts up to
 * a step after the range's start. */
const RANGE_MARGIN = 0.95;

/** The shortest of `candidates` whose last N days reach back to `at`; the
 * longest when none does (the frames then start after it - the newest shows). */
export const rangeContaining = (at: number, now: number, candidates: readonly TimeRange[]): TimeRange | null => {
  if (candidates.length === 0) {
    return null;
  }
  const sorted = [...candidates].sort((a, b) => TIME_RANGE_DAYS[a] - TIME_RANGE_DAYS[b]);
  const age = Math.max(0, now - at);
  return sorted.find((range) => TIME_RANGE_DAYS[range] * DAY_MS * RANGE_MARGIN >= age) ?? sorted[sorted.length - 1];
};
