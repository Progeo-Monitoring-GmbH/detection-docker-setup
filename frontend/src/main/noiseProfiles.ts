import type { MeasurementCompareRow } from '../components/device/MeasurementSamplesCompareChart';

/**
 * Störungsprofile (backend: helper/noise_profiles.py): per sensor the noise
 * floor of EP and WP of a device. A cleaned value is max(0, value - mask) -
 * the backend cleans with the device's active profile; on the Analyse tab
 * staff load the raw values and clean them here, so trying another profile
 * (or a draft) needs no request.
 */

export type NoiseProfile = {
  id: number;
  device: number;
  name: string;
  mask_e: number[];
  mask_w: number[];
  sum_e: number;
  sum_w: number;
  source_from: string | null;
  source_to: string | null;
  source_count: number;
  is_active: boolean;
  activated_at: string | null;
  created: string | null;
  updated: string | null;
  created_by: string | null;
};

/** A profile being made or edited - saved only on "Speichern". */
export type NoiseProfileDraft = {
  /** null: a new profile. */
  id: number | null;
  device: number;
  name: string;
  mask_e: number[];
  mask_w: number[];
  source_from: string | null;
  source_to: string | null;
  source_count: number;
};

/** The masks of a profile or draft, interleaved like the samples [EP, WP, ...]. */
export type NoiseMask = readonly number[];

export const noiseMaskOf = (profile: Pick<NoiseProfile, 'mask_e' | 'mask_w'> | null | undefined): NoiseMask | null => {
  if (!profile) {
    return null;
  }
  const sensors = Math.max(profile.mask_e.length, profile.mask_w.length);
  const mask = new Array<number>(sensors * 2);
  for (let sensor = 0; sensor < sensors; sensor += 1) {
    mask[sensor * 2] = Number(profile.mask_e[sensor] ?? 0) || 0;
    mask[sensor * 2 + 1] = Number(profile.mask_w[sensor] ?? 0) || 0;
  }
  return mask;
};

/** `samples` (interleaved) minus the mask, never below 0; sensors past the mask stay. */
export const applyNoiseMask = (samples: ReadonlyArray<number>, mask: NoiseMask): number[] => {
  const cleaned = samples.slice();
  const length = Math.min(samples.length, mask.length);
  for (let index = 0; index < length; index += 1) {
    const value = Number(samples[index]);
    cleaned[index] = value > mask[index] ? value - mask[index] : 0;
  }
  return cleaned;
};

/** |WP - EP| of every pair. */
export const pairValues = (samples: ReadonlyArray<number>): number[] => {
  const pairs = new Array<number>(Math.floor(samples.length / 2));
  for (let pair = 0; pair < pairs.length; pair += 1) {
    pairs[pair] = Math.abs(Number(samples[pair * 2 + 1]) - Number(samples[pair * 2]));
  }
  return pairs;
};

/** The rows with cleaned samples and pair values (same rows without a mask). */
export const cleanRows = (rows: MeasurementCompareRow[], mask: NoiseMask | null): MeasurementCompareRow[] => {
  if (!mask || !mask.length) {
    return rows;
  }
  return rows.map((row) => {
    if (!Array.isArray(row.samples) || !row.samples.length) {
      return row;
    }
    const samples = applyNoiseMask(row.samples, mask);
    return { ...row, samples, pair_abs_values: pairValues(samples) };
  });
};

export type NoiseRating = {
  /** 0..100: fit × effect. */
  score: number;
  /** 0..1: share of the masked values at or above the mask - below, the
   * profile cuts more than the noise floor of this period. */
  fit: number;
  /** -1..1: how much of the mean |WP - EP| the profile removes. */
  effect: number;
  /** Pair values over their threshold before / after cleaning. */
  exceedBefore: number;
  exceedAfter: number;
  /** Measurements rated. */
  measurements: number;
};

/**
 * How useful a profile is for the loaded (raw) measurements: it should take
 * away much of the signal (effect) without cutting into it (fit - values
 * below the mask are clamped to 0). `thresholdOf(pair)`: the alarm threshold
 * of a sensor (pair index), null for none.
 */
export const rateNoiseProfile = (
  rows: MeasurementCompareRow[],
  mask: NoiseMask | null,
  thresholdOf: (pair: number) => number | null,
): NoiseRating | null => {
  if (!mask || !rows.length) {
    return null;
  }
  let fitting = 0;
  let masked = 0;
  let rawSum = 0;
  let cleanSum = 0;
  let exceedBefore = 0;
  let exceedAfter = 0;
  let measurements = 0;
  const thresholds: Array<number | null | undefined> = [];
  const threshold = (pair: number) => {
    if (thresholds[pair] === undefined) {
      thresholds[pair] = thresholdOf(pair);
    }
    return thresholds[pair];
  };
  rows.forEach((row) => {
    const samples = row.samples;
    if (!Array.isArray(samples) || samples.length < 2) {
      return;
    }
    measurements += 1;
    const pairs = Math.floor(samples.length / 2);
    for (let pair = 0; pair < pairs; pair += 1) {
      const ep = Number(samples[pair * 2]);
      const wp = Number(samples[pair * 2 + 1]);
      const maskEp = mask[pair * 2] ?? 0;
      const maskWp = mask[pair * 2 + 1] ?? 0;
      const cleanEp = pair * 2 < mask.length ? (ep > maskEp ? ep - maskEp : 0) : ep;
      const cleanWp = pair * 2 + 1 < mask.length ? (wp > maskWp ? wp - maskWp : 0) : wp;
      if (pair * 2 < mask.length) {
        masked += 2;
        fitting += (ep >= maskEp ? 1 : 0) + (wp >= maskWp ? 1 : 0);
      }
      const raw = Math.abs(wp - ep);
      const clean = Math.abs(cleanWp - cleanEp);
      rawSum += raw;
      cleanSum += clean;
      const limit = threshold(pair);
      if (limit != null && limit > 0) {
        exceedBefore += raw > limit ? 1 : 0;
        exceedAfter += clean > limit ? 1 : 0;
      }
    }
  });
  if (!measurements) {
    return null;
  }
  const fit = masked ? fitting / masked : 1;
  const effect = rawSum > 0 ? Math.max(-1, Math.min(1, 1 - cleanSum / rawSum)) : 0;
  return {
    score: Math.round(100 * fit * Math.max(0, effect)),
    fit,
    effect,
    exceedBefore,
    exceedAfter,
    measurements,
  };
};

/** The masks as CSV (sensor;EP;WP) - the "CSV Störungsprofil" download. */
export const noiseProfileCsv = (profile: Pick<NoiseProfile, 'name' | 'mask_e' | 'mask_w'>): string => {
  const sensors = Math.max(profile.mask_e.length, profile.mask_w.length);
  const lines = ['sensor;ep;wp'];
  for (let sensor = 0; sensor < sensors; sensor += 1) {
    lines.push(`${sensor + 1};${profile.mask_e[sensor] ?? 0};${profile.mask_w[sensor] ?? 0}`);
  }
  return `${lines.join('\n')}\n`;
};

/**
 * The profile plot's painting: `mask` with the sensors `from`..`to` (0-based,
 * either order, inclusive) set along a straight line from `fromValue` to
 * `toValue` - so a fast drag across sensors leaves no gaps. Whole numbers,
 * never below 0; the mask grows (with 0) if needed.
 */
export const paintMask = (
  mask: ReadonlyArray<number>,
  from: number,
  to: number,
  fromValue: number,
  toValue: number,
): number[] => {
  const next = [...mask];
  const steps = Math.abs(to - from);
  const direction = to >= from ? 1 : -1;
  for (let step = 0; step <= steps; step += 1) {
    const index = from + step * direction;
    if (index < 0) {
      continue;
    }
    while (next.length <= index) {
      next.push(0);
    }
    const value = steps ? fromValue + ((toValue - fromValue) * step) / steps : toValue;
    next[index] = Math.max(0, Math.round(value));
  }
  return next;
};

/** A rating's traffic light. */
export type RatingLevel = 'good' | 'fair' | 'poor';
export type RatingMeasure = 'score' | 'fit' | 'effect';

/** From these on (score in %, fit / effect 0..1) a measure is good / fair. */
const RATING_LEVELS: Record<RatingMeasure, { good: number; fair: number }> = {
  score: { good: 70, fair: 40 },
  fit: { good: 0.9, fair: 0.75 },
  effect: { good: 0.5, fair: 0.25 },
};

export const ratingLevel = (measure: RatingMeasure, value: number): RatingLevel => {
  const { good, fair } = RATING_LEVELS[measure];
  return value >= good ? 'good' : value >= fair ? 'fair' : 'poor';
};

export type SpanUnit = 'day' | 'hour' | 'minute';

/**
 * A time span in at most two units, the larger first, zero units left out:
 * 7 d 5 h -> [day 7, hour 5]; 3 d -> [day 3]; 4 h 20 min -> [hour 4,
 * minute 20]. Minutes are rounded, never more precise than that.
 */
export const spanParts = (ms: number): { unit: SpanUnit; count: number }[] => {
  const minutes = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const parts =
    days > 0
      ? [
          { unit: 'day' as const, count: days },
          { unit: 'hour' as const, count: hours },
        ]
      : [
          { unit: 'hour' as const, count: hours },
          { unit: 'minute' as const, count: rest },
        ];
  const shown = parts.filter((part) => part.count > 0);
  return shown.length ? shown : [{ unit: 'minute', count: 0 }];
};

/** One manual change of a draft's masks, as the editor lists it. */
export type MaskChange = {
  /** The masks changed: EP, WP or both. */
  series: 'ep' | 'wp' | 'both';
  /** The sensors changed (1-based, inclusive) and how many. */
  first: number;
  last: number;
  count: number;
  /** The value before / after - for one sensor its own, for several their mean. */
  before: number;
  after: number;
};

const changedSensors = (before: ReadonlyArray<number>, after: ReadonlyArray<number>) => {
  const indexes: number[] = [];
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    if ((before[index] ?? 0) !== (after[index] ?? 0)) {
      indexes.push(index);
    }
  }
  return indexes;
};

const meanAt = (values: ReadonlyArray<number>, indexes: number[]) =>
  Math.round(indexes.reduce((sum, index) => sum + (values[index] ?? 0), 0) / indexes.length);

/** What a manual edit changed (null: nothing). */
export const describeMaskChange = (
  before: Pick<NoiseProfileDraft, 'mask_e' | 'mask_w'>,
  after: Pick<NoiseProfileDraft, 'mask_e' | 'mask_w'>,
): MaskChange | null => {
  const ep = changedSensors(before.mask_e, after.mask_e);
  const wp = changedSensors(before.mask_w, after.mask_w);
  if (!ep.length && !wp.length) {
    return null;
  }
  const series = ep.length && wp.length ? 'both' : ep.length ? 'ep' : 'wp';
  const indexes = [...new Set([...ep, ...wp])].sort((a, b) => a - b);
  // Both: the EP values stand for the change (they move together with Shift).
  const [from, to, sensors] = series === 'wp' ? [before.mask_w, after.mask_w, wp] : [before.mask_e, after.mask_e, ep];
  return {
    series,
    first: indexes[0] + 1,
    last: indexes[indexes.length - 1] + 1,
    count: indexes.length,
    before: meanAt(from, sensors),
    after: meanAt(to, sensors),
  };
};

/** A time span's length, short: "45 min", "4 h 20 min", "3 d 2 h". */
export const formatSpan = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} d ${rest} h` : `${days} d`;
};
