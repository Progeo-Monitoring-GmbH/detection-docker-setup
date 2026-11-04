import { describe, expect, it } from 'vitest';
import { frameAxisLabels, frameTimeAt, LABEL_CHAR_WIDTH, LABEL_GAP, labelCount } from './timeTicks';

const at = (month: number, day: number, hour = 0, minute = 0) => new Date(2026, month, day, hour, minute).getTime();

/** The labels' pixel extents on a `width` px axis, as TimeAxis places them. */
const extents = (labels: { fraction: number; label: string }[], width: number) =>
  labels.map(({ fraction, label }) => {
    const labelWidth = label.length * LABEL_CHAR_WIDTH;
    const left = fraction * width - fraction * labelWidth;
    return [left, left + labelWidth] as const;
  });

describe('frameAxisLabels', () => {
  it('starts at the first and ends at the last point, evenly spread', () => {
    const from = at(9, 14, 15);
    const to = at(9, 21, 15);
    const labels = frameAxisLabels({ from, to, width: 800, locale: 'de' });
    expect(labels[0]).toMatchObject({ fraction: 0, ms: from });
    expect(labels[labels.length - 1]).toMatchObject({ fraction: 1, ms: to });
    const steps = labels.slice(1).map((label, index) => label.fraction - labels[index].fraction);
    steps.forEach((step) => expect(step).toBeCloseTo(steps[0], 9));
  });

  it.each([
    ['24 h', at(9, 20, 20), at(9, 21, 20)],
    ['7 days', at(9, 14), at(9, 21)],
    ['30 days', at(8, 21), at(9, 21)],
    ['a year', at(0, 1), at(11, 31)],
    ['two years', at(0, 1) - 400 * 86_400_000, at(0, 1)],
  ])('never overlaps (%s)', (_, from, to) => {
    [120, 240, 375, 600, 1400].forEach((width) => {
      const boxes = extents(frameAxisLabels({ from, to, width, locale: 'de' }), width);
      boxes.slice(1).forEach(([left], index) => expect(left - boxes[index][1]).toBeGreaterThanOrEqual(LABEL_GAP - 0.001));
      expect(boxes[0][0]).toBeGreaterThanOrEqual(0);
      expect(boxes[boxes.length - 1][1]).toBeLessThanOrEqual(width + 0.001);
    });
  });

  it('shows times within a day, dates over several days', () => {
    expect(frameAxisLabels({ from: at(9, 21, 8), to: at(9, 21, 20), width: 600, locale: 'de' })[0].label).toBe('08:00');
    expect(frameAxisLabels({ from: at(9, 1), to: at(9, 21), width: 600, locale: 'de' })[0].label).toBe('01.10.');
  });

  it('adds the time where the dates would repeat', () => {
    const labels = frameAxisLabels({ from: at(9, 20), to: at(9, 22), width: 1400, locale: 'de' });
    expect(labels[0].label).toBe('20.10., 00:00');
    expect(new Set(labels.map((entry) => entry.label)).size).toBe(labels.length);
  });

  it('places the times by `timeAt` (the slider skips gaps)', () => {
    const timestamps = [0, 3600, 7200, 86_400 * 3].map((seconds) => at(9, 20) / 1000 + seconds);
    const labels = frameAxisLabels({
      from: timestamps[0] * 1000,
      to: timestamps[3] * 1000,
      width: 400,
      timeAt: (fraction) => frameTimeAt(timestamps, fraction),
      locale: 'de',
    });
    labels.forEach(({ fraction, ms }) => expect(ms).toBe(frameTimeAt(timestamps, fraction)));
  });

  it('has no labels without a span', () => {
    expect(frameAxisLabels({ from: 5, to: 5, width: 600 })).toEqual([]);
  });
});

describe('labelCount', () => {
  it('keeps at least the two ends', () => {
    expect(labelCount(50, 60)).toBe(2);
    expect(labelCount(300, 50, 10)).toBe(5);
  });
});

describe('frameTimeAt', () => {
  it('interpolates between the frames', () => {
    const timestamps = [0, 10, 100];
    expect(frameTimeAt(timestamps, 0)).toBe(0);
    expect(frameTimeAt(timestamps, 0.25)).toBe(5000);
    expect(frameTimeAt(timestamps, 0.75)).toBe(55_000);
    expect(frameTimeAt(timestamps, 1)).toBe(100_000);
  });
});
