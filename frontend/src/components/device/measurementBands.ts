import { parseTimestamp } from '../../main/alarmUtils';
import { nearestIndex } from '../../main/analyseCompare';

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
 * Per sensor (index in each list) over the lists: the mean, ± the standard
 * deviation and the range of its values - the bands of the "by sensor" plots.
 */
export const bandsOf = (lists: number[][]): SignedBands => {
  const sums: number[] = [];
  const squares: number[] = [];
  const counts: number[] = [];
  const minimums: number[] = [];
  const maximums: number[] = [];
  lists.forEach((values) =>
    values.forEach((value, index) => {
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

/** Per sensor over the measurements: the bands of WP - EP. */
export const signedBands = (rows: BandRow[]): SignedBands => bandsOf(rows.map(signedValuesOf));

/**
 * Per sensor over the period: the bands of its WP change - each measurement
 * of `rows` minus the one of `pastRows` nearest to `offsetMs` earlier.
 * Measurements without samples (or a match) are left out.
 */
export const wpChangeBands = (rows: BandRow[], pastRows: BandRow[], offsetMs: number): SignedBands => {
  const past = pastRows
    .flatMap((row) => {
      const ms = parseTimestamp(row.last_fetched);
      return ms == null ? [] : [{ seconds: ms / 1000, wp: potentialsOf(row.samples).wp }];
    })
    .sort((a, b) => a.seconds - b.seconds);
  const pastSeconds = past.map((entry) => entry.seconds);
  const changes = rows.flatMap((row) => {
    const ms = parseTimestamp(row.last_fetched);
    const index = ms == null ? -1 : nearestIndex(pastSeconds, (ms - offsetMs) / 1000);
    if (index < 0) {
      return [];
    }
    const now = potentialsOf(row.samples).wp;
    const then = past[index].wp;
    const count = Math.min(now.length, then.length);
    return count ? [Array.from({ length: count }, (_, sensor) => now[sensor] - then[sensor])] : [];
  });
  return bandsOf(changes);
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

/** A sensor's change between two measurements (now minus then). */
export type SensorChange = {
  /** Sensor index (from 0). */
  sensor: number;
  wpThen: number;
  wpNow: number;
  epThen: number;
  epNow: number;
  wpChange: number;
  epChange: number;
};

/**
 * Every sensor's change of WP and EP between two measurements' samples,
 * biggest first - by the larger of the two (magnitude). Sensors missing in
 * either are left out.
 */
export const sensorChanges = (
  nowSamples: number[] | null | undefined,
  thenSamples: number[] | null | undefined,
): SensorChange[] => {
  const now = potentialsOf(nowSamples);
  const then = potentialsOf(thenSamples);
  const count = Math.min(now.ep.length, then.ep.length);
  return Array.from({ length: count }, (_, sensor) => ({
    sensor,
    wpThen: then.wp[sensor],
    wpNow: now.wp[sensor],
    epThen: then.ep[sensor],
    epNow: now.ep[sensor],
    wpChange: now.wp[sensor] - then.wp[sensor],
    epChange: now.ep[sensor] - then.ep[sensor],
  })).sort(
    (a, b) =>
      Math.max(Math.abs(b.wpChange), Math.abs(b.epChange)) - Math.max(Math.abs(a.wpChange), Math.abs(a.epChange)) ||
      a.sensor - b.sensor,
  );
};
