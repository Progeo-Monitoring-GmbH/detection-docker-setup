import { describe, expect, it } from 'vitest';
import {
  availableTimeRanges,
  bucketLabel,
  effectiveTimeRange,
  SHORT_TIME_RANGES,
  TIME_RANGE_DAYS,
  timeRangeCandidates,
  timeRangeLabelKey,
  type MeasurementRange,
} from './timeRanges';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const rangeFrom = (daysBack: number): MeasurementRange => ({
  first: new Date(NOW - daysBack * DAY_MS).toISOString(),
  last: new Date(NOW - DAY_MS).toISOString(),
  count: 100,
});

const LONG = timeRangeCandidates({ long: true });

describe('TIME_RANGE_DAYS', () => {
  it('maps every range to its request days, shortest first', () => {
    expect(TIME_RANGE_DAYS).toEqual({
      '24h': 1,
      '7d': 7,
      '30d': 30,
      '90d': 90,
      '180d': 180,
      '1y': 365,
      '3y': 1095,
    });
  });

  it('stays within what the backend accepts (days <= 1096)', () => {
    Object.values(TIME_RANGE_DAYS).forEach((days) =>
      expect(days).toBeLessThanOrEqual(1096),
    );
  });

  it('builds the status_range_* label keys', () => {
    expect(timeRangeLabelKey('30d')).toBe('status_range_30d');
    expect(timeRangeLabelKey('3y')).toBe('status_range_3y');
  });
});

describe('timeRangeCandidates', () => {
  it('is the short ranges by default', () => {
    expect(timeRangeCandidates()).toEqual(['24h', '7d', '30d']);
  });

  it('adds 1y/3y for long views', () => {
    expect(timeRangeCandidates({ long: true })).toEqual(['24h', '7d', '30d', '1y', '3y']);
  });

  it('adds quarter, half year and year for staff', () => {
    expect(timeRangeCandidates({ staff: true })).toEqual([
      '24h',
      '7d',
      '30d',
      '90d',
      '180d',
      '1y',
    ]);
    expect(timeRangeCandidates({ long: true, staff: true })).toEqual([
      '24h',
      '7d',
      '30d',
      '90d',
      '180d',
      '1y',
      '3y',
    ]);
  });
});

describe('availableTimeRanges', () => {
  it('offers only the short ranges without a measurement range', () => {
    expect(availableTimeRanges(null, LONG, NOW)).toEqual(['24h', '7d', '30d']);
    expect(availableTimeRanges(undefined, LONG, NOW)).toEqual(['24h', '7d', '30d']);
  });

  it('offers only the shortest range without measurements', () => {
    expect(
      availableTimeRanges({ first: null, last: null, count: 0 }, LONG, NOW),
    ).toEqual(['24h']);
  });

  it('ignores an unparsable first timestamp', () => {
    expect(
      availableTimeRanges({ first: 'garbage', last: null, count: 1 }, LONG, NOW),
    ).toEqual(['24h', '7d', '30d']);
  });

  it('offers no range the data does not reach into', () => {
    expect(availableTimeRanges(rangeFrom(0.5), LONG, NOW)).toEqual(['24h']);
    expect(availableTimeRanges(rangeFrom(1), LONG, NOW)).toEqual(['24h']);
    expect(availableTimeRanges(rangeFrom(2), LONG, NOW)).toEqual(['24h', '7d']);
    expect(availableTimeRanges(rangeFrom(7), LONG, NOW)).toEqual(['24h', '7d']);
    expect(availableTimeRanges(rangeFrom(8), LONG, NOW)).toEqual(['24h', '7d', '30d']);
  });

  it('offers 1y only once the data spans more than 30 days', () => {
    expect(availableTimeRanges(rangeFrom(10), LONG, NOW)).toEqual(['24h', '7d', '30d']);
    expect(availableTimeRanges(rangeFrom(30), LONG, NOW)).toEqual(['24h', '7d', '30d']);
    expect(availableTimeRanges(rangeFrom(31), LONG, NOW)).toEqual([
      '24h',
      '7d',
      '30d',
      '1y',
    ]);
  });

  it('offers 3y only once the data spans more than a year', () => {
    expect(availableTimeRanges(rangeFrom(365), LONG, NOW)).toEqual([
      '24h',
      '7d',
      '30d',
      '1y',
    ]);
    expect(availableTimeRanges(rangeFrom(366), LONG, NOW)).toEqual([
      '24h',
      '7d',
      '30d',
      '1y',
      '3y',
    ]);
    expect(availableTimeRanges(rangeFrom(5 * 365), LONG, NOW)).toEqual([
      '24h',
      '7d',
      '30d',
      '1y',
      '3y',
    ]);
  });

  it('steps the staff ranges along the data', () => {
    const staff = timeRangeCandidates({ staff: true });
    expect(availableTimeRanges(rangeFrom(60), staff, NOW)).toEqual(['24h', '7d', '30d', '90d']);
    expect(availableTimeRanges(rangeFrom(120), staff, NOW)).toEqual([
      '24h',
      '7d',
      '30d',
      '90d',
      '180d',
    ]);
    expect(availableTimeRanges(rangeFrom(200), staff, NOW)).toEqual(staff);
  });

  it('defaults to the long candidates', () => {
    expect(availableTimeRanges(rangeFrom(400))).toEqual(LONG);
  });

  it('does not hand out the shared short list itself', () => {
    const ranges = availableTimeRanges(null, SHORT_TIME_RANGES, NOW);
    ranges.push('3y');
    expect(SHORT_TIME_RANGES).toEqual(['24h', '7d', '30d']);
  });
});

describe('effectiveTimeRange', () => {
  it('keeps an offered selection', () => {
    expect(effectiveTimeRange('7d', ['24h', '7d', '30d'])).toBe('7d');
    expect(effectiveTimeRange('3y', ['24h', '7d', '30d', '1y', '3y'])).toBe('3y');
  });

  it('falls back to the longest offered range', () => {
    expect(effectiveTimeRange('3y', ['24h', '7d', '30d', '1y'])).toBe('1y');
    expect(effectiveTimeRange('1y', ['24h', '7d', '30d'])).toBe('30d');
    expect(effectiveTimeRange('3y', ['7d', '24h'])).toBe('7d');
  });

  it('keeps the selection when nothing is offered', () => {
    expect(effectiveTimeRange('7d', [])).toBe('7d');
  });
});

describe('bucketLabel', () => {
  it('is null for raw data', () => {
    expect(bucketLabel(null)).toBeNull();
    expect(bucketLabel(undefined)).toBeNull();
    expect(bucketLabel(0)).toBeNull();
    expect(bucketLabel(-3600)).toBeNull();
    expect(bucketLabel(Number.NaN)).toBeNull();
  });

  it('names daily and weekly buckets', () => {
    expect(bucketLabel(86400)).toEqual({ key: 'climate_bucket_daily', count: 1 });
    expect(bucketLabel(7 * 86400)).toEqual({ key: 'climate_bucket_weekly', count: 1 });
    expect(bucketLabel(2 * 86400)).toEqual({ key: 'climate_bucket_days', count: 2 });
  });

  it('names hourly buckets, also non-whole days', () => {
    expect(bucketLabel(3600)).toEqual({ key: 'climate_bucket_hourly', count: 1 });
    expect(bucketLabel(6 * 3600)).toEqual({ key: 'climate_bucket_hours', count: 6 });
    expect(bucketLabel(36 * 3600)).toEqual({ key: 'climate_bucket_hours', count: 36 });
  });

  it('falls back to minutes below an hour', () => {
    expect(bucketLabel(900)).toEqual({ key: 'climate_bucket_minutes', count: 15 });
    expect(bucketLabel(10)).toEqual({ key: 'climate_bucket_minutes', count: 1 });
  });
});
