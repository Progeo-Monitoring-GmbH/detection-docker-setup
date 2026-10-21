import { describe, expect, it } from 'vitest';
import {
  alignDown,
  alignUp,
  alignedFrom,
  defaultWindow,
  frameCount,
  heatmapQuery,
  HEATMAP_STEPS,
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

describe('window', () => {
  it('defaults to the last seven days in hourly steps', () => {
    const newest = new Date(2026, 9, 21, 14, 37).getTime();
    const window = defaultWindow(newest);
    expect(window.step).toBe(3600);
    expect(window.to).toBe(new Date(2026, 9, 21, 15, 0).getTime());
    expect(window.to - window.from).toBeGreaterThanOrEqual(7 * DAY);
    expect(frameCount(window.from, window.to, window.step)).toBe(168);
  });

  it('starts the query on a step boundary', () => {
    const from = new Date(2026, 9, 14, 13, 30).getTime();
    const window = { from, to: from + 3 * DAY, step: 86400 };
    expect(alignedFrom(window)).toBe(new Date(2026, 9, 14, 0, 0).getTime());
    const query = new URLSearchParams(heatmapQuery(window));
    expect(new Date(query.get('from') as string).getTime()).toBe(alignedFrom(window));
    expect(query.get('step')).toBe('86400');
  });
});
