import { describe, expect, it } from 'vitest';
import { formatDateTime, toLocalIso } from './dateFormat';

describe('formatDateTime', () => {
  it('returns a dash placeholder for null, undefined and empty strings', () => {
    expect(formatDateTime(null)).toBe('–');
    expect(formatDateTime(undefined)).toBe('–');
    expect(formatDateTime()).toBe('–');
    expect(formatDateTime('')).toBe('–');
  });

  it('returns a dash placeholder (not "Invalid Date") for unparseable strings', () => {
    expect(formatDateTime('not a date')).toBe('–');
    expect(formatDateTime('2026-13-45T99:99:99')).toBe('–');
  });

  it('formats a valid ISO string with toLocaleString', () => {
    const value = '2026-08-19T11:08:00Z';
    expect(formatDateTime(value)).toBe(new Date(value).toLocaleString());
    expect(formatDateTime(value)).not.toBe('–');
  });
});

describe('toLocalIso', () => {
  it('zero-pads every component and uses a 1-based month', () => {
    const ms = new Date(2026, 0, 5, 3, 4, 7).getTime();
    expect(toLocalIso(ms)).toBe('2026-01-05T03:04:07');
  });

  it('keeps two-digit components untouched', () => {
    const ms = new Date(2025, 11, 31, 23, 59, 58).getTime();
    expect(toLocalIso(ms)).toBe('2025-12-31T23:59:58');
  });

  it('drops milliseconds and has no timezone suffix', () => {
    const ms = new Date(2026, 5, 15, 12, 30, 45, 999).getTime();
    const result = toLocalIso(ms);
    expect(result).toBe('2026-06-15T12:30:45');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it('formats midnight as 00:00:00', () => {
    const ms = new Date(2026, 9, 1, 0, 0, 0).getTime();
    expect(toLocalIso(ms)).toBe('2026-10-01T00:00:00');
  });

  it('round-trips through the Date constructor as local time', () => {
    const ms = new Date(2026, 2, 9, 8, 7, 6).getTime();
    expect(new Date(toLocalIso(ms)).getTime()).toBe(ms);
  });
});
