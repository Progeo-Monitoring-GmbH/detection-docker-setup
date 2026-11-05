import { describe, expect, it } from 'vitest';
import {
  applyNoiseMask,
  cleanRows,
  editMask,
  noiseMaskOf,
  noiseProfileCsv,
  rateNoiseProfile,
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

describe('editMask', () => {
  const draft = { mask_e: [10, 20, 30], mask_w: [1, 2, 3] };

  it('changes the chosen mask over the chosen sensors', () => {
    expect(editMask(draft, 'ep', 'add', 5, 2, 3)).toEqual({ mask_e: [10, 25, 35], mask_w: [1, 2, 3] });
    expect(editMask(draft, 'both', 'multiply', 1.5, 1, 1)).toEqual({ mask_e: [15, 20, 30], mask_w: [2, 2, 3] });
    expect(editMask(draft, 'wp', 'set', 0, 1, 99)).toEqual({ mask_e: [10, 20, 30], mask_w: [0, 0, 0] });
  });

  it('never goes below 0', () => {
    expect(editMask(draft, 'both', 'add', -15, 1, 3).mask_e).toEqual([0, 5, 15]);
  });
});

it('exports the masks as CSV', () => {
  expect(noiseProfileCsv({ name: 'x', mask_e: [1, 2], mask_w: [3] })).toBe('sensor;ep;wp\n1;1;3\n2;2;0\n');
});
