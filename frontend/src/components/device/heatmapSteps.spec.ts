import { describe, expect, it } from 'vitest';
import {
  alignDown,
  alignUp,
  defaultStepForRange,
  frameCount,
  heatmapQuery,
  HEATMAP_STEPS,
  stepsForRange,
} from './heatmapSteps';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('alignment', () => {
  it('rounds to full hours and local midnight', () => {
    const moment = new Date(2026, 9, 21, 14, 37, 12).getTime();
    expect(alignDown(moment, HOUR)).toBe(new Date(2026, 9, 21, 14, 0, 0).getTime());
    expect(alignUp(moment, HOUR)).toBe(new Date(2026, 9, 21, 15, 0, 0).getTime());
    expect(alignDown(moment, DAY)).toBe(new Date(2026, 9, 21, 0, 0, 0).getTime());
  });

  it('keeps an aligned moment', () => {
    const hour = new Date(2026, 9, 21, 14, 0, 0).getTime();
    expect(alignUp(hour, HOUR)).toBe(hour);
  });
});

describe('frames', () => {
  it('counts the steps of a window', () => {
    expect(frameCount(0, 7 * DAY, 3600)).toBe(168);
    expect(frameCount(0, 7 * DAY + 1, 3600)).toBe(169);
    expect(frameCount(5, 5, 3600)).toBe(0);
  });

  it('offers the agreed steps', () => {
    expect(HEATMAP_STEPS.map((step) => step.key)).toEqual(['30m', '1h', '2h', '4h', '6h', '1d', '2d', '7d', '14d']);
  });
});

describe('steps per range', () => {
  it('picks a step that is easy to follow for each Zeitreihe range', () => {
    expect(defaultStepForRange(1, 1800)).toBe(1800); // 24 h: 48 frames
    expect(defaultStepForRange(7, 1800)).toBe(3600); // 7 days: 168
    expect(defaultStepForRange(30, 1800)).toBe(4 * 3600); // 30 days: 180
    expect(defaultStepForRange(365, 1800)).toBe(2 * 86400); // 1 year: 183
    expect(defaultStepForRange(1095, 7200)).toBe(7 * 86400); // 3 years: 157
  });

  it('offers only steps shorter than the range, groupable from the history, within the frame limit', () => {
    expect(stepsForRange(1, 1800).map((step) => step.key)).toEqual(['30m', '1h', '2h', '4h', '6h']);
    expect(stepsForRange(365, 1800).map((step) => step.key)).toEqual(['6h', '1d', '2d', '7d', '14d']);
    expect(stepsForRange(1095, 7200).map((step) => step.key)).toEqual(['1d', '2d', '7d', '14d']);
  });
});

describe('query', () => {
  it('starts on a step boundary', () => {
    const from = new Date(2026, 9, 14, 13, 30).getTime();
    const query = new URLSearchParams(heatmapQuery({ from, to: from + 3 * DAY, step: 86400 }));
    expect(new Date(query.get('from') as string).getTime()).toBe(new Date(2026, 9, 14, 0, 0).getTime());
    expect(query.get('step')).toBe('86400');
  });
});
