import { parseTimestamp } from '../../main/alarmUtils';

/** What the bands read of a measurement (MeasurementCompareRow). */
type BandRow = {
  last_fetched: string | null;
  samples: number[];
  pair_abs_values?: number[];
};

/** EP / WP of the interleaved samples [eigen, wirk, ...]; an unpaired last value is dropped. */
export const potentialsOf = (samples: number[] | null | undefined) => {
  const ep: number[] = [];
  const wp: number[] = [];
  if (!Array.isArray(samples)) {
    return { ep, wp };
  }
  const pairCount = Math.floor(samples.length / 2);
  for (let i = 0; i < pairCount; i += 1) {
    ep.push(Number(samples[i * 2] || 0));
    wp.push(Number(samples[i * 2 + 1] || 0));
  }
  return { ep, wp };
};

/** A measurement's WP - EP by sensor (index from 0) - without samples its
 * |WP - EP| (pair_abs_values). */
export const signedValuesOf = (row: BandRow): number[] => {
  const { ep, wp } = potentialsOf(row.samples);
  if (ep.length) {
    return wp.map((value, index) => value - ep[index]);
  }
  return (row.pair_abs_values ?? []).map((value) => Number(value || 0));
};

export type SignedBands = {
  /** Sensor numbers (from 1). */
  x: number[];
  mean: number[];
  /** Mean ± one standard deviation ("Abweichung"). */
  upper: number[];
  lower: number[];
  sigma: number[];
  /** Lowest / highest value ("Spannweite"). */
  min: number[];
  max: number[];
};

/**
 * Per sensor over the measurements: the mean of WP - EP, ± its standard
 * deviation and its range - the bands of the "by sensor" plots.
 */
export const signedBands = (rows: BandRow[]): SignedBands => {
  const sums: number[] = [];
  const squares: number[] = [];
  const counts: number[] = [];
  const minimums: number[] = [];
  const maximums: number[] = [];
  rows.forEach((row) =>
    signedValuesOf(row).forEach((value, index) => {
      minimums[index] = Math.min(minimums[index] ?? value, value);
      maximums[index] = Math.max(maximums[index] ?? value, value);
      sums[index] = (sums[index] || 0) + value;
      squares[index] = (squares[index] || 0) + value * value;
      counts[index] = (counts[index] || 0) + 1;
    }),
  );
  const bands: SignedBands = { x: [], mean: [], upper: [], lower: [], sigma: [], min: [], max: [] };
  counts.forEach((count, index) => {
    if (!count) {
      return;
    }
    const mean = sums[index] / count;
    const sigma = Math.sqrt(Math.max(squares[index] / count - mean * mean, 0));
    bands.x.push(index + 1);
    bands.mean.push(mean);
    bands.sigma.push(sigma);
    bands.upper.push(mean + sigma);
    bands.lower.push(mean - sigma);
    bands.min.push(minimums[index]);
    bands.max.push(maximums[index]);
  });
  return bands;
};

/** The measurement nearest in time to `ms` (null: the newest); null without any. */
export const nearestRow = <T extends { last_fetched: string | null }>(rows: T[], ms: number | null): T | null => {
  let best: T | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  rows.forEach((row) => {
    const time = parseTimestamp(row.last_fetched);
    if (time == null) {
      return;
    }
    const score = ms == null ? -time : Math.abs(time - ms);
    if (score < bestScore) {
      best = row;
      bestScore = score;
    }
  });
  return best;
};
