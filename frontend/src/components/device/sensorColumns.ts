/**
 * The geometry of SensorColumnsPlot (the measurements' first plot): one
 * column per sensor - like the threshold mixer, from 4 to 500 sensors - and
 * which sensors the "hide below" level leaves out.
 */

/** Column width (px): never narrower (then the plot scrolls), never wider (4 sensors stay slim). */
export const MIN_COLUMN = 14;
export const MAX_COLUMN = 64;
/** Ctrl + wheel may zoom out this far (all of many sensors at once). */
const MIN_ZOOM_COLUMN = 3;

/** The spread of WP − EP per sensor over the period (measurementBands.signedBands). */
export type SensorSpread = {
  min: number[];
  max: number[];
  lower: number[];
  upper: number[];
  mean: number[];
  sigma: number[];
};

/** A sensor's highest |WP − EP| of the period - what "hide below" compares. */
export const peakOf = (spread: SensorSpread, sensor: number) =>
  Math.max(Math.abs(spread.min[sensor] ?? 0), Math.abs(spread.max[sensor] ?? 0));

/**
 * The sensors (index) the plot shows: every one whose peak reaches `level`
 * - and the selected ones, whatever they read (they are followed below).
 */
export const shownSensors = (
  count: number,
  spread: SensorSpread,
  level: number,
  selected: readonly number[],
): number[] => {
  const keep = new Set(selected);
  return Array.from({ length: count }, (_, sensor) => sensor).filter(
    (sensor) => level <= 0 || keep.has(sensor) || peakOf(spread, sensor) >= level,
  );
};

/** A column's width (px) for `count` columns in `width` px, Ctrl + wheel's `zoom` first. */
export const columnWidthOf = (width: number, count: number, zoom: number | null) => {
  const fit = Math.max(MIN_ZOOM_COLUMN, width / Math.max(count, 1));
  if (zoom != null) {
    return Math.min(MAX_COLUMN, Math.max(Math.min(fit, MIN_COLUMN), zoom));
  }
  return Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, fit));
};

/** Round tick values from `low` to `high` - about `about` of them, 1/2/2.5/5 x 10^n apart, 0 among them. */
export const niceTicks = (low: number, high: number, about = 5) => {
  if (!(high > low)) {
    return [0];
  }
  const raw = (high - low) / about;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((factor) => factor * power >= raw) ?? 10) * power;
  const ticks: number[] = [];
  for (let value = Math.ceil(low / step) * step; value <= high + step * 1e-9; value += step) {
    ticks.push(Number(value.toFixed(6)));
  }
  return ticks;
};

/** Where things sit in a column (fractions of its width). */
export type ColumnSlots = {
  /** The period's spread (whisker, middle-50 % box, mean); null while hidden. */
  spread: [number, number] | null;
  /** The slider's measurement, one bar each; empty while hidden. */
  bars: Array<{ key: CurrentSeries; from: number; to: number }>;
};

export type CurrentSeries = 'ep' | 'wp' | 'sum';

/**
 * The spread on the left, the measurement's bars on the right - side by
 * side, so neither hides the other. Alone, either takes the whole column.
 */
export const columnSlots = (withSpread: boolean, bars: readonly CurrentSeries[]): ColumnSlots => {
  const [from, to] = [0.12, 0.88];
  const split = withSpread && bars.length ? 0.5 : null;
  const spread: [number, number] | null = withSpread ? [from, split != null ? split - 0.04 : to] : null;
  const barsFrom = split != null ? split + 0.04 : from;
  const each = bars.length ? (to - barsFrom) / bars.length : 0;
  return {
    spread,
    bars: bars.map((key, index) => ({ key, from: barsFrom + index * each, to: barsFrom + (index + 1) * each })),
  };
};
