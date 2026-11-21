import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import {
  chartFramesOf,
  frameSecondsOf,
  pageKeyHintsOf,
  pageTipsOf,
} from './analysePageHelp';

const t = ((key: string, options?: { name?: string }) =>
  options?.name ? `${key}:${options.name}` : key) as unknown as TFunction;

describe('pageKeyHintsOf', () => {
  it('lists the frame keys and the zoom', () => {
    const hints = pageKeyHintsOf(t, {
      planHotkeys: false,
      planCount: 1,
      offerNoiseProfiles: false,
    });
    expect(hints.map((hint) => hint.id)).toEqual([
      'play',
      'frame-step',
      'frame-jump',
      undefined,
    ]);
    expect(hints[3].label).toBe('key_hint_zoom');
  });

  it('adds the plan keys (at most 9) and the span keys for staff', () => {
    const hints = pageKeyHintsOf(t, {
      planHotkeys: true,
      planCount: 12,
      offerNoiseProfiles: true,
    });
    expect(hints.map((hint) => hint.id)).toEqual([
      'play',
      'frame-step',
      'frame-jump',
      'plan',
      'range-select',
      'range-clear',
      undefined,
    ]);
    expect(hints[3].keys).toEqual(['1 … 9']);
  });
});

describe('pageTipsOf', () => {
  const tips = (options: Partial<Parameters<typeof pageTipsOf>[1]>) =>
    pageTipsOf(t, {
      offerNoiseProfiles: true,
      hasDraft: false,
      hasRange: false,
      noiseView: 'none',
      activeName: null,
      ...options,
    });

  it('only the frames tip without profiles', () => {
    expect(tips({ offerNoiseProfiles: false, hasDraft: true })).toEqual([
      'usage_tip_frames',
    ]);
  });

  it('the next profile step, the active profile while it cleans', () => {
    expect(tips({})).toEqual(['usage_tip_range_pick', 'usage_tip_frames']);
    expect(tips({ hasRange: true })).toEqual([
      'usage_tip_range_selected',
      'usage_tip_frames',
    ]);
    expect(
      tips({
        hasDraft: true,
        hasRange: true,
        noiseView: 'draft',
        activeName: 'A',
      }),
    ).toEqual(['usage_tip_draft', 'usage_tip_frames']);
    expect(tips({ noiseView: 'active', activeName: 'A' })).toEqual([
      'usage_tip_range_pick',
      'usage_tip_active:A',
      'usage_tip_frames',
    ]);
  });
});

describe('chartFramesOf / frameSecondsOf', () => {
  it('sorts the measurement times (s), skipping unreadable ones', () => {
    expect(
      chartFramesOf([
        { last_fetched: '1970-01-01T00:00:20Z' },
        { last_fetched: null },
        { last_fetched: '1970-01-01T00:00:10Z' },
      ] as never[]),
    ).toEqual([10, 20]);
  });

  it("prefers the heatmap's frames", () => {
    expect(frameSecondsOf([1, 2], [3])).toEqual([1, 2]);
    expect(frameSecondsOf([], [3])).toEqual([3]);
  });
});
