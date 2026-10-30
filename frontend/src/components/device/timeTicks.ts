/**
 * Marks of a time axis (the heatmap's window and frame sliders): calendar
 * boundaries - full hours, midnights, Mondays, first days of a month or year -
 * at the finest interval that keeps at most `maxTicks` of them. Local time.
 */

export type TimeTick = {
  ms: number;
  label: string;
  /** A coarser boundary (midnight, first of a month, new year): drawn stronger. */
  major: boolean;
};

type Interval =
  | { unit: 'hour'; count: number }
  | { unit: 'day'; count: number }
  | { unit: 'week'; count: number }
  | { unit: 'month'; count: number }
  | { unit: 'year'; count: number };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const INTERVALS: Array<{ interval: Interval; approxMs: number }> = [
  ...[1, 2, 3, 6, 12].map((count) => ({ interval: { unit: 'hour', count } as Interval, approxMs: count * HOUR })),
  ...[1, 2].map((count) => ({ interval: { unit: 'day', count } as Interval, approxMs: count * DAY })),
  ...[1, 2].map((count) => ({ interval: { unit: 'week', count } as Interval, approxMs: count * 7 * DAY })),
  ...[1, 2, 3, 6].map((count) => ({ interval: { unit: 'month', count } as Interval, approxMs: count * 30.4 * DAY })),
  ...[1, 2, 5, 10].map((count) => ({ interval: { unit: 'year', count } as Interval, approxMs: count * 365 * DAY })),
];

/** The first boundary of `interval` at or after `ms`. */
const firstBoundary = (ms: number, interval: Interval) => {
  const date = new Date(ms);
  switch (interval.unit) {
    case 'hour':
      date.setMinutes(0, 0, 0);
      while (date.getTime() < ms || date.getHours() % interval.count !== 0) {
        date.setHours(date.getHours() + 1);
      }
      break;
    case 'day':
    case 'week':
      date.setHours(0, 0, 0, 0);
      while (date.getTime() < ms || (interval.unit === 'week' && date.getDay() !== 1)) {
        date.setDate(date.getDate() + 1);
      }
      break;
    case 'month':
      date.setHours(0, 0, 0, 0);
      date.setDate(1);
      while (date.getTime() < ms || date.getMonth() % interval.count !== 0) {
        date.setMonth(date.getMonth() + 1);
      }
      break;
    case 'year':
      date.setHours(0, 0, 0, 0);
      date.setMonth(0, 1);
      while (date.getTime() < ms || date.getFullYear() % interval.count !== 0) {
        date.setFullYear(date.getFullYear() + 1);
      }
      break;
  }
  return date;
};

const advance = (date: Date, interval: Interval) => {
  switch (interval.unit) {
    case 'hour':
      date.setHours(date.getHours() + interval.count);
      break;
    case 'day':
      date.setDate(date.getDate() + interval.count);
      break;
    case 'week':
      date.setDate(date.getDate() + 7 * interval.count);
      break;
    case 'month':
      date.setMonth(date.getMonth() + interval.count);
      break;
    case 'year':
      date.setFullYear(date.getFullYear() + interval.count);
      break;
  }
};

const dayLabel = (date: Date, locale?: string) =>
  date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });

const monthLabel = (date: Date, locale?: string) =>
  date.getMonth() === 0
    ? String(date.getFullYear())
    : date.toLocaleDateString(locale, { month: 'short' });

const tickOf = (date: Date, interval: Interval, locale?: string): TimeTick => {
  const ms = date.getTime();
  const midnight = date.getHours() === 0 && date.getMinutes() === 0;
  switch (interval.unit) {
    case 'hour':
      return midnight
        ? { ms, label: dayLabel(date, locale), major: true }
        : { ms, label: date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }), major: false };
    case 'day':
    case 'week':
      return date.getDate() === 1
        ? { ms, label: monthLabel(date, locale), major: true }
        : { ms, label: dayLabel(date, locale), major: false };
    case 'month':
      return { ms, label: monthLabel(date, locale), major: date.getMonth() === 0 };
    case 'year':
      return { ms, label: String(date.getFullYear()), major: true };
  }
};

/**
 * The placed marks (`x` in px, ascending) whose labels don't run into each
 * other: each kept at least `minGap` from the one before. Of two too close,
 * the first stays - unless only the second is major.
 * Needed where the axis isn't linear in time: a frame slider leaves out
 * the time without data, so the marks of a gap fall close together.
 */
export const spacedTicks = <T extends { tick: { major: boolean }; x: number }>(
  placed: T[],
  minGap: number,
): T[] => {
  const kept: T[] = [];
  placed.forEach((entry) => {
    const last = kept[kept.length - 1];
    if (!last || entry.x - last.x >= minGap) {
      kept.push(entry);
      return;
    }
    // Still far enough from the one before `last`: that one is minGap before `last`.
    if (entry.tick.major && !last.tick.major) {
      kept[kept.length - 1] = entry;
    }
  });
  return kept;
};

/** The marks between `from` and `to` (ms), at most `maxTicks` (at least the
 * coarsest interval's). */
export const timeTicks = (from: number, to: number, maxTicks: number, locale?: string): TimeTick[] => {
  if (!(to > from) || maxTicks < 1) {
    return [];
  }
  const span = to - from;
  const { interval } =
    INTERVALS.find((candidate) => span / candidate.approxMs <= maxTicks) ?? INTERVALS[INTERVALS.length - 1];
  const ticks: TimeTick[] = [];
  const date = firstBoundary(from, interval);
  // A month/year interval can still give a few more than estimated.
  while (date.getTime() <= to && ticks.length <= maxTicks * 2) {
    ticks.push(tickOf(date, interval, locale));
    advance(date, interval);
  }
  return ticks;
};
