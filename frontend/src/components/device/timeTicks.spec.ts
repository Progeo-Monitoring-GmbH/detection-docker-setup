import { describe, expect, it } from 'vitest';
import { spacedTicks, timeTicks } from './timeTicks';

const at = (month: number, day: number, hour = 0) => new Date(2026, month, day, hour).getTime();

describe('timeTicks', () => {
  it('marks full hours over a day, midnight stronger', () => {
    const ticks = timeTicks(at(9, 20, 20), at(9, 21, 8), 10, 'de');
    // 20:00 - 08:00, at most 10 marks: every second hour.
    expect(ticks.map((tick) => new Date(tick.ms).getHours())).toEqual([20, 22, 0, 2, 4, 6, 8]);
    const midnight = ticks.find((tick) => new Date(tick.ms).getHours() === 0)!;
    expect(midnight.major).toBe(true);
    expect(midnight.label).toBe('21.10.');
  });

  it('marks days over a week', () => {
    const ticks = timeTicks(at(9, 14, 15), at(9, 21, 15), 10, 'de');
    expect(ticks.map((tick) => new Date(tick.ms).getDate())).toEqual([15, 16, 17, 18, 19, 20, 21]);
    expect(ticks.every((tick) => new Date(tick.ms).getHours() === 0)).toBe(true);
    expect(ticks[0].label).toBe('15.10.');
  });

  it('marks Mondays over two months, the first of a month stronger', () => {
    const ticks = timeTicks(at(7, 20), at(9, 21), 10, 'de');
    expect(ticks.every((tick) => new Date(tick.ms).getDay() === 1)).toBe(true);
  });

  it('marks months over a year, a new year with its number', () => {
    const ticks = timeTicks(at(1, 10), at(13, 5), 14, 'de');
    expect(ticks.every((tick) => new Date(tick.ms).getDate() === 1)).toBe(true);
    const newYear = ticks.find((tick) => new Date(tick.ms).getMonth() === 0)!;
    expect(newYear.label).toBe('2027');
    expect(newYear.major).toBe(true);
  });

  it('never gives more marks than asked for', () => {
    for (const days of [1, 3, 10, 45, 200, 800, 4000]) {
      const ticks = timeTicks(at(0, 1), at(0, 1) + days * 24 * 3600 * 1000, 8, 'de');
      expect(ticks.length).toBeLessThanOrEqual(9);
      expect(ticks.length).toBeGreaterThan(0);
    }
  });
});

describe('spacedTicks', () => {
  const mark = (x: number, major = false) => ({ tick: { major }, x });

  it('leaves out the marks that fall too close together (a gap without data)', () => {
    const kept = spacedTicks([mark(0), mark(100), mark(110), mark(115), mark(200)], 50);
    expect(kept.map((entry) => entry.x)).toEqual([0, 100, 200]);
  });

  it('prefers a major mark over a too close minor one', () => {
    const kept = spacedTicks([mark(0), mark(100), mark(120, true), mark(200)], 50);
    expect(kept.map((entry) => entry.x)).toEqual([0, 120, 200]);
  });});
