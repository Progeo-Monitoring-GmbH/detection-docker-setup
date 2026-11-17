/**
 * The two-row time axis of the Zeitreihe chart (ThresholdTrendChart): a fine
 * row (times of day - or days, or months for long spans) with a faint grid
 * line at every tick, and a coarse row below it (days - or months, or years)
 * whose boundaries are drawn as stronger lines. Ticks sit on "round" local
 * times (every 3 h, at midnight, on the 1st), not on arbitrary fractions.
 *
 * Pure - positions in the chart's own units (`x0`..`x1`), so it is tested
 * without rendering.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Fine steps within a day, smallest first. */
const TIME_STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720].map((minutes) => minutes * MINUTE);
/** Fine steps in days. */
const DAY_STEPS = [1, 2, 7, 14];
/** Fine steps in months. */
const MONTH_STEPS = [1, 2, 3, 6];

export type AxisTick = {
  /** Position in chart units. */
  x: number;
  ms: number;
  /** Null: a grid line without a label (no room for it). */
  label: string | null;
};

export type AxisSpanLabel = {
  /** Centre of the label in chart units. */
  x: number;
  label: string;
};

export type TrendTimeAxis = {
  /** The fine row: a faint line each, labelled where there is room. */
  minor: AxisTick[];
  /** Boundaries of the coarse row (midnights, 1st of the month, ...): stronger lines. */
  boundaries: AxisTick[];
  /** The coarse row's labels, centred on their (visible part of the) day / month / year. */
  spans: AxisSpanLabel[];
};

type AxisOptions = {
  x0: number;
  x1: number;
  locale?: string;
  /** Width of one label character in chart units. */
  charWidth: number;
  /** Least room between two labels, in chart units. */
  gap?: number;
  /** Labels may reach this far outside x0..x1 (the axis margins). */
  overhang?: number;
};

const format = (locale: string | undefined, options: Intl.DateTimeFormatOptions) => {
  try {
    const formatter = new Intl.DateTimeFormat(locale, options);
    return (ms: number) => formatter.format(ms);
  } catch {
    const formatter = new Intl.DateTimeFormat(undefined, options);
    return (ms: number) => formatter.format(ms);
  }
};

const startOfDay = (ms: number) => {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const addDays = (ms: number, days: number) => {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
};

const startOfMonth = (ms: number) => {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  date.setDate(1);
  return date.getTime();
};

const addMonths = (ms: number, months: number) => {
  const date = new Date(ms);
  date.setMonth(date.getMonth() + months);
  return date.getTime();
};

const startOfYear = (ms: number) => {
  const date = new Date(startOfMonth(ms));
  date.setMonth(0);
  return date.getTime();
};

/** Local times from `first` on, `next` after each, up to `to`. */
const walk = (first: number, to: number, next: (ms: number) => number) => {
  const times: number[] = [];
  for (let ms = first; ms <= to && times.length < 1000; ms = next(ms)) {
    times.push(ms);
  }
  return times;
};

/**
 * The axis from `from` to `to` (ms). A zero span (one point in time) gets a
 * single label in the middle.
 */
export const trendTimeAxis = (
  from: number,
  to: number,
  { x0, x1, locale, charWidth, gap = 12, overhang = 6 }: AxisOptions,
): TrendTimeAxis => {
  const width = x1 - x0;
  if (!(to > from)) {
    const label = format(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })(from);
    return { minor: [{ x: (x0 + x1) / 2, ms: from, label }], boundaries: [], spans: [] };
  }
  const span = to - from;
  const toX = (ms: number) => x0 + ((ms - from) / span) * width;
  const fits = (label: string, x: number) => {
    const half = (label.length * charWidth) / 2;
    return x - half >= x0 - overhang - 30 && x + half <= x1 + overhang;
  };

  // The fine row: the smallest step whose labels don't touch.
  const minorWidth = (sample: string) => sample.length * charWidth + gap;
  const timeLabel = format(locale, { hour: '2-digit', minute: '2-digit' });
  const dayNumber = format(locale, { day: 'numeric' });
  const monthShort = format(locale, { month: 'short' });

  let minorTimes: number[];
  let minorLabel: (ms: number) => string;
  let boundaryTimes: number[];
  let nextBoundary: (ms: number) => number;
  let spanFormats: Array<(ms: number) => string>;

  const timeStep = TIME_STEPS.find((step) => (step / span) * width >= minorWidth(timeLabel(from)));
  if (timeStep) {
    const dayStart = startOfDay(from);
    minorTimes = walk(dayStart, to, (ms) => ms + timeStep).filter((ms) => ms >= from);
    minorLabel = timeLabel;
    nextBoundary = (ms) => addDays(ms, 1);
    boundaryTimes = walk(dayStart, to, nextBoundary);
    spanFormats = [
      format(locale, { weekday: 'short', day: '2-digit', month: '2-digit' }),
      format(locale, { day: '2-digit', month: '2-digit' }),
      dayNumber,
    ];
  } else {
    const dayStep = DAY_STEPS.find((step) => ((step * DAY) / span) * width >= minorWidth('00'));
    if (dayStep) {
      // Every day / every 2nd day of the month (1, 3, 5, ...) / the 1st, 8th,
      // 15th, 22nd / the 1st and 15th - restarting on each 1st, without a
      // tick right before it (the 31st next to the 1st).
      minorTimes = walk(startOfMonth(from), to, (ms) => addDays(ms, 1)).filter((ms) => {
        const date = new Date(ms);
        const day = date.getDate();
        const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
        return ms >= from && (day - 1) % dayStep === 0 && (day === 1 || day + dayStep <= daysInMonth + 1);
      });
      minorLabel = dayNumber;
      nextBoundary = (ms) => addMonths(ms, 1);
      boundaryTimes = walk(startOfMonth(from), to, nextBoundary);
      spanFormats = [format(locale, { month: 'long', year: 'numeric' }), format(locale, { month: 'short', year: '2-digit' }), monthShort];
    } else {
      const monthStep =
        MONTH_STEPS.find((step) => ((step * 30.4 * DAY) / span) * width >= minorWidth(monthShort(from))) ?? 12;
      minorTimes = walk(startOfYear(from), to, (ms) => addMonths(ms, 1)).filter(
        (ms) => ms >= from && new Date(ms).getMonth() % monthStep === 0,
      );
      minorLabel = monthShort;
      nextBoundary = (ms) => addMonths(ms, 12);
      boundaryTimes = walk(startOfYear(from), to, nextBoundary);
      spanFormats = [format(locale, { year: 'numeric' })];
    }
  }

  const minor = minorTimes.map((ms) => {
    const x = toX(ms);
    const label = minorLabel(ms);
    return { x, ms, label: fits(label, x) ? label : null };
  });

  // The coarse row: a line at each boundary inside the span, a label centred
  // on the visible part of each period - the longest format that fits it.
  const boundaries = boundaryTimes
    .filter((ms) => ms > from && ms < to)
    .map((ms) => ({ x: toX(ms), ms, label: null }));
  const spans: AxisSpanLabel[] = [];
  boundaryTimes.forEach((start) => {
    const visibleFrom = Math.max(start, from);
    const visibleTo = Math.min(nextBoundary(start), to);
    if (visibleTo <= visibleFrom) {
      return;
    }
    const room = toX(visibleTo) - toX(visibleFrom);
    const label = spanFormats.map((formatter) => formatter(visibleFrom)).find(
      (text) => text.length * charWidth + gap / 2 <= room,
    );
    if (label) {
      spans.push({ x: (toX(visibleFrom) + toX(visibleTo)) / 2, label });
    }
  });

  return { minor, boundaries, spans };
};
