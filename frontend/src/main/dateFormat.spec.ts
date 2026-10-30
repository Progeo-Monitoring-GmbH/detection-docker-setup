import i18next from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';
import { dateLocale, formatDate, toLocalIso } from './dateFormat';

const ms = new Date(2026, 7, 19, 11, 8, 9).getTime();

describe('formatDate', () => {
  afterEach(() => {
    i18next.language = undefined as unknown as string;
  });

  it('returns a dash placeholder for null, undefined and empty strings', () => {
    expect(formatDate(null)).toBe('–');
    expect(formatDate(undefined)).toBe('–');
    expect(formatDate('')).toBe('–');
  });

  it('returns a dash placeholder (not "Invalid Date") for unparseable values', () => {
    expect(formatDate('not a date')).toBe('–');
    expect(formatDate('2026-13-45T99:99:99')).toBe('–');
    expect(formatDate(Number.NaN)).toBe('–');
  });

  it('falls back to our pretty format without a (known) language', () => {
    expect(formatDate(ms)).toBe('19.08.2026, 11:08');
    expect(formatDate(ms, 'dateTimeSeconds')).toBe('19.08.2026, 11:08:09');
    expect(formatDate(ms, 'date')).toBe('19.08.2026');
    expect(formatDate(ms, 'time')).toBe('11:08');
    expect(formatDate(ms, 'dayMonthTime')).toBe('19.08., 11:08');
  });

  it('reads Dates, epoch ms, ISO strings and our pretty strings alike', () => {
    expect(formatDate(new Date(ms))).toBe('19.08.2026, 11:08');
    expect(formatDate('2026-08-19T11:08:09')).toBe('19.08.2026, 11:08');
    expect(formatDate('19.08.2026, 11:08')).toBe('19.08.2026, 11:08');
  });

  it("formats in the user's language", () => {
    i18next.language = 'en-US';
    expect(formatDate(ms)).toBe(new Date(ms).toLocaleString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
    expect(formatDate(ms, 'date')).toBe('08/19/2026');
  });
});

describe('dateLocale', () => {
  it('is the language when Intl knows it, else null', () => {
    expect(dateLocale('de')).toBe('de');
    expect(dateLocale('en-GB')).toBe('en-GB');
    expect(dateLocale('cimode')).toBeNull();
    expect(dateLocale('')).toBeNull();
    expect(dateLocale('not a language!')).toBeNull();
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
