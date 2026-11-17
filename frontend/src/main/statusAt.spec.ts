import { describe, expect, it } from 'vitest';
import { parseStatusAt, rangeContaining } from './statusAt';
import { timeRangeCandidates } from './timeRanges';

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('parseStatusAt', () => {
  it('reads ISO-8601 times with offset, Z or fraction (as Django writes them)', () => {
    expect(parseStatusAt('2026-11-17T10:00:00Z', NOW)).toBe(Date.UTC(2026, 10, 17, 10, 0, 0));
    expect(parseStatusAt('2026-11-17T11:00:00+01:00', NOW)).toBe(Date.UTC(2026, 10, 17, 10, 0, 0));
    expect(parseStatusAt('2026-11-17T10:00:00.123456+00:00', NOW)).toBe(Date.UTC(2026, 10, 17, 10, 0, 0, 123));
    expect(parseStatusAt('2026-11-10', NOW)).toBe(Date.UTC(2026, 10, 10));
  });

  it('ignores missing, malformed and impossible values', () => {
    expect(parseStatusAt(null, NOW)).toBeNull();
    expect(parseStatusAt('', NOW)).toBeNull();
    expect(parseStatusAt('yesterday', NOW)).toBeNull();
    expect(parseStatusAt('17.11.2026 10:00', NOW)).toBeNull();
    expect(parseStatusAt('1763373600000', NOW)).toBeNull();
    expect(parseStatusAt('2026-13-40T99:99:00Z', NOW)).toBeNull();
  });

  it('ignores times in the future beyond a small clock tolerance', () => {
    expect(parseStatusAt('2026-11-17T12:03:00Z', NOW)).toBe(NOW + 3 * 60 * 1000);
    expect(parseStatusAt('2026-11-18T12:00:00Z', NOW)).toBeNull();
  });
});

describe('rangeContaining', () => {
  const customer = timeRangeCandidates({ long: true });
  const staff = timeRangeCandidates({ long: true, staff: true });

  it('picks the shortest range reaching back to the time', () => {
    expect(rangeContaining(NOW - 2 * HOUR, NOW, customer)).toBe('24h');
    expect(rangeContaining(NOW - 3 * DAY, NOW, customer)).toBe('7d');
    expect(rangeContaining(NOW - 20 * DAY, NOW, customer)).toBe('30d');
    expect(rangeContaining(NOW - 60 * DAY, NOW, customer)).toBe('1y');
    expect(rangeContaining(NOW - 60 * DAY, NOW, staff)).toBe('90d');
  });

  it('keeps a margin at the range start, where the first frame may begin later', () => {
    expect(rangeContaining(NOW - 6.9 * DAY, NOW, customer)).toBe('30d');
  });

  it('falls back to the longest range for very old times, and to null without candidates', () => {
    expect(rangeContaining(NOW - 5000 * DAY, NOW, customer)).toBe('3y');
    expect(rangeContaining(NOW, NOW, [])).toBeNull();
  });

  it('does not depend on the candidates order', () => {
    expect(rangeContaining(NOW - 3 * DAY, NOW, ['3y', '30d', '7d', '24h'])).toBe('7d');
  });
});
