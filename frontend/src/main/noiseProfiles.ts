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

export type MaskTarget = 'both' | 'ep' | 'wp';
export type MaskOperation = 'add' | 'multiply' | 'set';

/**
 * The editor's bulk change: `operation` with `value` on the EP and/or WP
 * mask of sensors `from`..`to` (1-based, inclusive) - whole numbers, never
 * below 0.
 */
export const editMask = (
  draft: Pick<NoiseProfileDraft, 'mask_e' | 'mask_w'>,
  target: MaskTarget,
  operation: MaskOperation,
  value: number,
  from: number,
  to: number,
): Pick<NoiseProfileDraft, 'mask_e' | 'mask_w'> => {
  const change = (mask: number[]) =>
    mask.map((current, index) => {
      const sensor = index + 1;
      if (sensor < from || sensor > to) {
        return current;
      }
      const next = operation === 'add' ? current + value : operation === 'multiply' ? current * value : value;
      return Math.max(0, Math.round(next));
    });
  return {
    mask_e: target === 'wp' ? draft.mask_e : change(draft.mask_e),
    mask_w: target === 'ep' ? draft.mask_w : change(draft.mask_w),
  };
};
