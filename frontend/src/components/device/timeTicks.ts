/**
 * Labels of a frame slider's time axis: evenly spread over the axis, from
 * the first to the last frame, each showing the time at its place (the
 * slider leaves out gaps without data, so that time is interpolated between
 * the frames - see `timeAt`). As many as fit without overlapping.
 */

export type AxisLabel = {
  /** Place on the axis, 0..1. */
  fraction: number;
  /** The time there (epoch ms). */
  ms: number;
  label: string;
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Approximate width (px) of one character of the 11 px axis font - digits
 * and separators; a little generous, so labels never touch. */
export const LABEL_CHAR_WIDTH = 6.6;
/** Least free space (px) between two labels. */
export const LABEL_GAP = 14;

const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
const TIME_SECONDS: Intl.DateTimeFormatOptions = { ...TIME, second: '2-digit' };
const DAY_MONTH: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit' };
const DAY_MONTH_YEAR: Intl.DateTimeFormatOptions = { ...DAY_MONTH, year: '2-digit' };

/** The label formats for a span, coarse to fine: the first whose labels are
 * all distinct is used. */
const formatsFor = (span: number): Intl.DateTimeFormatOptions[] => {
  if (span < DAY) {
    return [TIME, TIME_SECONDS];
  }
  if (span < 300 * DAY) {
    return [DAY_MONTH, { ...DAY_MONTH, ...TIME }];
  }
  return [DAY_MONTH_YEAR, { ...DAY_MONTH_YEAR, ...TIME }];
};

const formatter = (options: Intl.DateTimeFormatOptions, locale?: string) => {
  const format = new Intl.DateTimeFormat(locale, options);
  return (ms: number) => format.format(ms);
};

/** How many labels of `labelWidth` fit on `width` px. Label i sits at
 * fraction f = i / (n - 1) and is anchored at f of its own width (the first
 * left-aligned, the last right-aligned), so they take up `width - labelWidth`
 * evenly - each needs `labelWidth + gap` of it. */
export const labelCount = (width: number, labelWidth: number, gap = LABEL_GAP) =>
  width > labelWidth ? Math.max(2, Math.floor((width - labelWidth) / (labelWidth + gap)) + 1) : 2;

/**
 * The labels of an axis from `from` to `to` (ms), `width` px wide. `timeAt`
 * gives the time at a place on the axis (0..1) - linear between `from` and
 * `to` by default.
 */
export const frameAxisLabels = ({
  from,
  to,
  width,
  timeAt,
  locale,
}: {
  from: number;
  to: number;
  width: number;
  timeAt?: (fraction: number) => number;
  locale?: string;
}): AxisLabel[] => {
  if (!(to > from) || !(width > 0)) {
    return [];
  }
  const at = timeAt ?? ((fraction: number) => from + (to - from) * fraction);
  const formats = formatsFor(to - from);
  let labels: AxisLabel[] = [];
  for (const options of formats) {
    const format = formatter(options, locale);
    // Every label of a format is (about) as wide - the longest of the ends.
    const longest = Math.max(format(from).length, format(to).length);
    const count = labelCount(width, longest * LABEL_CHAR_WIDTH);
    labels = Array.from({ length: count }, (_, index) => {
      const fraction = index / (count - 1);
      const ms = at(fraction);
      return { fraction, ms, label: format(ms) };
    });
    const distinct = labels.every((entry, index) => index === 0 || entry.label !== labels[index - 1].label);
    if (distinct) {
      return labels;
    }
  }
  // Even the finest format repeats (frames very close together): drop the
  // repeats - fewer labels never overlap.
  return labels.filter((entry, index) => index === 0 || entry.label !== labels[index - 1].label);
};

/** The time at a place (0..1) of a slider over the frames `timestamps`
 * (seconds, oldest first, one slider step each): between two frames
 * interpolated. In ms. */
export const frameTimeAt = (timestamps: number[], fraction: number) => {
  const count = timestamps.length;
  if (count === 0) {
    return Number.NaN;
  }
  const position = Math.min(Math.max(fraction, 0), 1) * (count - 1);
  const low = Math.floor(position);
  const high = Math.min(low + 1, count - 1);
  return (timestamps[low] + (timestamps[high] - timestamps[low]) * (position - low)) * 1000;
};
