import { describe, expect, it } from 'vitest';
import { measurementsQuery } from './measurementQuery';

describe('measurementsQuery', () => {
  it('requests the latest 300 measurements when no year is given', () => {
    expect(measurementsQuery()).toBe('limit=300');
    expect(measurementsQuery(undefined)).toBe('limit=300');
  });

  it('requests a whole year when a year is given', () => {
    expect(measurementsQuery(2026)).toBe('year=2026');
    expect(measurementsQuery(1999)).toBe('year=1999');
  });

  it('never combines year and limit', () => {
    const params = new URLSearchParams(measurementsQuery(2024));
    expect(params.get('year')).toBe('2024');
    expect(params.has('limit')).toBe(false);
  });

  it('treats year 0 as "no year" (falsy)', () => {
    expect(measurementsQuery(0)).toBe('limit=300');
  });
});
