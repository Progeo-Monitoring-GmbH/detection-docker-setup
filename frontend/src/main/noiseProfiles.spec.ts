import { describe, expect, it } from 'vitest';
import {
  applyNoiseMask,
  cleanRows,
  formatSpan,
  noiseMaskOf,
  noiseProfileCsv,
  paintMask,
  rateNoiseProfile,
  ratingLevel,
} from './noiseProfiles';

const row = (id: number, samples: number[]) => ({
  id,
  device: 1,
  last_fetched: `2026-11-0${id}T10:00:00`,
  samples,
  pair_abs_values: samples.length ? [Math.abs(samples[1] - samples[0])] : [],
});

describe('noise masks', () => {
  it('interleave the EP and WP masks, padding the shorter one', () => {
    expect(noiseMaskOf({ mask_e: [1, 2], mask_w: [3] })).toEqual([1, 3, 2, 0]);
    expect(noiseMaskOf(null)).toBeNull();
  });

  it('subtract per value and clamp at 0 - as the backend does', () => {
    // backend test_mask_subtracts_per_value_and_clamps_at_zero
    expect(applyNoiseMask([10, 4, 12, 9], [3, 5, 10, 2])).toEqual([7, 0, 2, 7]);
  });

  it('leave sensors past the mask alone', () => {
    expect(applyNoiseMask([5, 6, 7, 8], [1, 1])).toEqual([4, 5, 7, 8]);
  });

  it('clean rows: samples and pair values', () => {
    const rows = [{ id: 1, device: 1, last_fetched: null, samples: [100, 400, 50, 60], pair_abs_values: [300, 10] }];

    const [cleaned] = cleanRows(rows, noiseMaskOf({ mask_e: [100, 40], mask_w: [150, 60] }));

    expect(cleaned.samples).toEqual([0, 250, 10, 0]);
    expect(cleaned.pair_abs_values).toEqual([250, 10]);
    expect(cleanRows(rows, null)).toBe(rows);
  });
});

describe('rateNoiseProfile', () => {
  const rows = [row(1, [100, 400]), row(2, [120, 300])];

  it('rates a fitting mask by what it removes', () => {
    const rating = rateNoiseProfile(rows, noiseMaskOf({ mask_e: [100], mask_w: [300] }), () => 150);

    // raw pairs 300 + 180 = 480; cleaned |100 - 0| + |0 - 20| = 120.
    expect(rating).toMatchObject({ fit: 1, effect: 0.75, score: 75, exceedBefore: 2, exceedAfter: 0, measurements: 2 });
  });

  it('marks down a mask that cuts into the signal', () => {
    const rating = rateNoiseProfile(rows, noiseMaskOf({ mask_e: [110], mask_w: [350] }), () => null);

    // EP 100 < 110 and WP 300 < 350: two of four values below the mask.
    expect(rating?.fit).toBe(0.5);
    expect(rating?.exceedBefore).toBe(0);
    expect(rating!.score).toBeLessThan(50);
  });

  it('gives nothing without a mask or rows', () => {
    expect(rateNoiseProfile(rows, null, () => null)).toBeNull();
    expect(rateNoiseProfile([], [1, 1], () => null)).toBeNull();
  });
});

describe('noiseProfileCsv', () => {
  it('lists every sensor with its EP and WP mask, padding the shorter one', () => {
    expect(noiseProfileCsv({ name: 'P', mask_e: [10, 20], mask_w: [5] })).toBe('sensor;ep;wp\n1;10;5\n2;20;0\n');
  });
});

describe('paintMask', () => {
  it('sets one sensor, whole and never below 0', () => {
    expect(paintMask([10, 20, 30], 1, 1, 24.6, 24.6)).toEqual([10, 25, 30]);
    expect(paintMask([10, 20, 30], 2, 2, -5, -5)).toEqual([10, 20, 0]);
  });

  it('fills the sensors between two drag points along a line - in both directions', () => {
    expect(paintMask([0, 0, 0, 0, 0], 0, 4, 0, 40)).toEqual([0, 10, 20, 30, 40]);
    expect(paintMask([0, 0, 0, 0, 0], 4, 0, 0, 40)).toEqual([40, 30, 20, 10, 0]);
  });

  it('grows a shorter mask', () => {
    expect(paintMask([5], 2, 2, 7, 7)).toEqual([5, 0, 7]);
  });
});

describe('ratingLevel', () => {
  it('gives the traffic light of each measure', () => {
    expect(ratingLevel('score', 70)).toBe('good');
    expect(ratingLevel('score', 40)).toBe('fair');
    expect(ratingLevel('score', 39)).toBe('poor');
    expect(ratingLevel('fit', 0.95)).toBe('good');
    expect(ratingLevel('effect', -0.2)).toBe('poor');
  });
});

describe('formatSpan', () => {
  it('reads minutes, hours and days', () => {
    expect(formatSpan(45 * 60000)).toBe('45 min');
    expect(formatSpan(4 * 3600000 + 20 * 60000)).toBe('4 h 20 min');
    expect(formatSpan(3 * 86400000)).toBe('3 d');
    expect(formatSpan(3 * 86400000 + 2 * 3600000)).toBe('3 d 2 h');
  });
});
