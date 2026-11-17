import { describe, expect, it } from 'vitest';
import { trendTimeAxis } from './trendTimeAxis';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OPTIONS = { x0: 40, x1: 990, locale: 'de-DE', charWidth: 5.4 };
// Local midnight, so the expectations don't depend on the test machine's zone.
const MIDNIGHT = new Date(2026, 10, 16, 0, 0, 0).getTime();

describe('trendTimeAxis', () => {
  it('a day: times of day on round hours, the day below', () => {
    const axis = trendTimeAxis(MIDNIGHT + 1 * HOUR, MIDNIGHT + 23 * HOUR, OPTIONS);

    const labels = axis.minor.flatMap((tick) => (tick.label ? [tick.label] : []));
    expect(labels.length).toBeGreaterThan(6);
    labels.forEach((label) => expect(label).toMatch(/^\d\d:00$/));
    expect(axis.boundaries).toEqual([]);
    expect(axis.spans).toHaveLength(1);
    expect(axis.spans[0].label).toContain('16.11.');
  });

  it('a week: a boundary at every midnight and a label per day', () => {
    const axis = trendTimeAxis(MIDNIGHT + 6 * HOUR, MIDNIGHT + 7 * DAY, OPTIONS);

    expect(axis.boundaries).toHaveLength(6);
    expect(axis.spans).toHaveLength(7);
    expect(new Set(axis.spans.map((span) => span.label)).size).toBe(7);
    // Ticks inside the span, in order.
    const xs = axis.minor.map((tick) => tick.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(40);
    expect(Math.max(...xs)).toBeLessThanOrEqual(990);
  });

  it('two months: days in the fine row, the months below', () => {
    const from = new Date(2026, 9, 10).getTime();
    const to = new Date(2026, 11, 5).getTime();
    const axis = trendTimeAxis(from, to, OPTIONS);

    axis.minor.forEach((tick) => expect(new Date(tick.ms).getHours()).toBe(0));
    expect(axis.boundaries).toHaveLength(2);
    expect(axis.spans.map((span) => span.label)).toEqual(
      expect.arrayContaining([expect.stringContaining('November')]),
    );
  });

  it('years: months in the fine row, the years below', () => {
    const axis = trendTimeAxis(new Date(2024, 2, 1).getTime(), new Date(2026, 5, 1).getTime(), OPTIONS);

    expect(axis.spans.map((span) => span.label)).toEqual(['2024', '2025', '2026']);
    axis.minor.forEach((tick) => expect(new Date(tick.ms).getDate()).toBe(1));
  });

  it('labels never overlap', () => {
    const axis = trendTimeAxis(MIDNIGHT, MIDNIGHT + 3 * DAY, OPTIONS);
    const labelled = axis.minor.filter((tick) => tick.label);
    labelled.slice(1).forEach((tick, index) => {
      const previous = labelled[index];
      expect(tick.x - previous.x).toBeGreaterThanOrEqual(((previous.label!.length + tick.label!.length) / 2) * 5.4);
    });
  });

  it('a single point in time: one label in the middle', () => {
    const axis = trendTimeAxis(MIDNIGHT, MIDNIGHT, OPTIONS);
    expect(axis.minor).toHaveLength(1);
    expect(axis.minor[0].x).toBe(515);
    expect(axis.spans).toEqual([]);
  });
});
