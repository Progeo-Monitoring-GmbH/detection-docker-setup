import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import {
  deviceProfilesOf,
  displayMaskOf,
  heatNoiseQueryOf,
  maskLinesOf,
  noiseBadgeOf,
  noiseViewOf,
  referenceSamplesOf,
  shownProfilesOf,
  thresholdDataOf,
} from './analyseNoiseView';
import type { NoiseProfile, NoiseProfileDraft } from './noiseProfiles';

const t = ((key: string, options?: { name?: string }) =>
  options?.name ? `${key}:${options.name}` : key) as unknown as TFunction;

const profile = (id: number, mask: number[]): NoiseProfile => ({
  id,
  device: 10,
  name: `P${id}`,
  mask_e: mask,
  mask_w: mask.map((value) => value + 1),
  sum_e: 0,
  sum_w: 0,
  source_from: null,
  source_to: null,
  source_count: 0,
  is_active: false,
  activated_at: null,
  created: null,
  updated: null,
  created_by: null,
});

const draft: NoiseProfileDraft = {
  id: null,
  device: 10,
  name: 'Draft',
  mask_e: [5],
  mask_w: [6],
  source_from: null,
  source_to: null,
  source_count: 0,
};
const active = profile(1, [1]);
const tested = profile(2, [3]);

describe('noiseViewOf', () => {
  it('prefers the draft, then the tried-out profile, then the active one', () => {
    const none = {
      shownDraft: null,
      draftPreview: true,
      testedProfile: null,
      activeProfile: null,
    };
    expect(noiseViewOf(none)).toBe('none');
    expect(noiseViewOf({ ...none, activeProfile: active })).toBe('active');
    expect(
      noiseViewOf({ ...none, activeProfile: active, testedProfile: tested }),
    ).toBe('test');
    expect(
      noiseViewOf({ ...none, testedProfile: tested, shownDraft: draft }),
    ).toBe('draft');
    expect(
      noiseViewOf({ ...none, shownDraft: draft, draftPreview: false }),
    ).toBe('raw');
  });
});

describe('displayMaskOf', () => {
  const profiles = {
    shownDraft: draft,
    draftPreview: true,
    testedProfile: tested,
    activeProfile: active,
  };

  it('is the mask of what the view cleans with', () => {
    expect(displayMaskOf(true, 'draft', profiles)).toEqual([5, 6]);
    expect(displayMaskOf(true, 'test', profiles)).toEqual([3, 4]);
    expect(displayMaskOf(true, 'active', profiles)).toEqual([1, 2]);
  });

  it('is null for raw values, none or without profiles offered', () => {
    expect(displayMaskOf(true, 'raw', profiles)).toBeNull();
    expect(displayMaskOf(true, 'none', profiles)).toBeNull();
    expect(displayMaskOf(false, 'active', profiles)).toBeNull();
  });
});

describe('maskLinesOf', () => {
  it("draws the draft's masks only over the raw values", () => {
    expect(maskLinesOf(true, 'raw', draft)).toEqual({ ep: [5], wp: [6] });
    expect(maskLinesOf(true, 'draft', draft)).toBeNull();
    expect(maskLinesOf(false, 'raw', draft)).toBeNull();
    expect(maskLinesOf(true, 'raw', null)).toBeNull();
  });
});

describe('heatNoiseQueryOf', () => {
  it('asks the backend for raw values or the tried-out profile', () => {
    expect(heatNoiseQueryOf(true, 'raw', null)).toBe('&raw=1');
    expect(heatNoiseQueryOf(true, 'test', tested)).toBe('&noise_profile=2');
    expect(heatNoiseQueryOf(true, 'test', null)).toBe('');
    expect(heatNoiseQueryOf(true, 'draft', tested)).toBe('');
    expect(heatNoiseQueryOf(true, 'active', null)).toBe('');
    expect(heatNoiseQueryOf(false, 'raw', null)).toBe('');
  });
});

describe('referenceSamplesOf', () => {
  const rows = [
    { last_fetched: '2026-11-01T00:00:00Z', samples: [1, 2, 3, 4] },
    { last_fetched: '2026-11-02T00:00:00Z', samples: [5, 6, 7, 8] },
    { last_fetched: null, samples: [9, 9] },
  ] as never[];

  it('splits the newest measurement into EP and WP without a frame', () => {
    expect(referenceSamplesOf(rows, null)).toEqual({ ep: [5, 7], wp: [6, 8] });
  });

  it('takes the measurement nearest to the frame', () => {
    expect(
      referenceSamplesOf(rows, Date.parse('2026-11-01T03:00:00Z')),
    ).toEqual({ ep: [1, 3], wp: [2, 4] });
  });

  it('is null without measurements', () => {
    expect(referenceSamplesOf([], null)).toBeNull();
  });
});

describe('noiseBadgeOf', () => {
  it('names the profile the values are cleaned with', () => {
    expect(noiseBadgeOf(t, 'active', active, null)).toMatchObject({
      text: 'noise_badge_active:P1',
      hint: 'noise_badge_active_hint:P1',
      color: '#1e7b34',
    });
    expect(noiseBadgeOf(t, 'test', active, tested)).toMatchObject({
      text: 'noise_badge_test:P2',
      hint: 'noise_badge_test_hint',
    });
    expect(noiseBadgeOf(t, 'draft', null, null)).toMatchObject({
      text: 'noise_badge_draft',
    });
  });

  it('is null for raw values or without a profile', () => {
    expect(noiseBadgeOf(t, 'raw', active, null)).toBeNull();
    expect(noiseBadgeOf(t, 'none', null, null)).toBeNull();
    expect(noiseBadgeOf(t, 'active', null, null)).toBeNull();
  });
});

describe('deviceProfilesOf / shownProfilesOf', () => {
  const other = { ...profile(3, [0]), device: 20 };
  const activeOne = { ...active, is_active: true };
  const load = { locationId: 5, profiles: [activeOne, tested, other] };

  it("keeps the shown device's profiles of this location", () => {
    expect(deviceProfilesOf(load, 5, 10)).toEqual([activeOne, tested]);
    expect(deviceProfilesOf(load, 5, 20)).toEqual([other]);
    expect(deviceProfilesOf(load, 6, 10)).toEqual([]);
    expect(deviceProfilesOf(null, 5, 10)).toEqual([]);
  });

  it('picks the active and the tried-out profile and the draft of the device', () => {
    expect(shownProfilesOf([activeOne, tested], 2, draft, 10)).toEqual({
      activeProfile: activeOne,
      testedProfile: tested,
      shownDraft: draft,
    });
    expect(shownProfilesOf([tested], 9, draft, 20)).toEqual({
      activeProfile: null,
      testedProfile: null,
      shownDraft: null,
    });
  });
});

describe('thresholdDataOf', () => {
  const heatmap = {
    data: { '1': [4] },
    timestamps: [1],
    sensor_points: [{ pos: 1, x: 0, y: 0, device: 10, pair: 1 }],
  } as SensorHeatmapResponse;
  const rows = [
    { last_fetched: '2026-11-01T00:00:00Z', samples: [1, 9] },
  ] as never[];

  it('names the rated profile and the period', () => {
    const data = thresholdDataOf(t, {
      heatmap,
      measurements: rows,
      ratedProfile: active,
      shownDevice: 10,
      range: '7d',
    });
    expect(data.note).toBe('thresholds_source_profile:P1');
    expect(data.sensors.map((sensor) => sensor.sensor_order)).toEqual([1]);
  });

  it('says the values are raw without a profile', () => {
    expect(
      thresholdDataOf(t, {
        heatmap,
        measurements: rows,
        ratedProfile: null,
        shownDevice: 10,
        range: '7d',
      }).note,
    ).toBe('thresholds_source_raw');
  });
});
