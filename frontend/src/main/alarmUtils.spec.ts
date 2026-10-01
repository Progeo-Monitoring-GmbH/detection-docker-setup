import { describe, expect, it } from 'vitest';
import { plotTheme } from '../styles/plotTheme';
import {
  alarmHeatColor,
  alarmPeakValue,
  alarmRainSpans,
  alarmSensors,
  alarmStartTime,
  formatDuration,
  isAlarmActive,
  parseTimestamp,
} from './alarmUtils';

const HOUR_MS = 60 * 60 * 1000;

describe('formatDuration', () => {
  it('formats zero as "0s"', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('formats seconds only', () => {
    expect(formatDuration(42)).toBe('42s');
  });

  it('skips empty units', () => {
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(86400)).toBe('1d');
    expect(formatDuration(86400 + 5)).toBe('1d 5s');
    expect(formatDuration(3600 + 60)).toBe('1h 1m');
  });

  it('formats all units together', () => {
    expect(formatDuration(86400 + 2 * 3600 + 3 * 60 + 4)).toBe('1d 2h 3m 4s');
  });

  it('floors fractional seconds', () => {
    expect(formatDuration(59.9)).toBe('59s');
    expect(formatDuration(0.4)).toBe('0s');
  });

  it('returns "-" for negative and non-finite input', () => {
    expect(formatDuration(-1)).toBe('-');
    expect(formatDuration(Number.NaN)).toBe('-');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('-');
  });
});

describe('parseTimestamp', () => {
  it('returns null for empty input', () => {
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
    expect(parseTimestamp('')).toBeNull();
  });

  it('parses ISO-8601 strings', () => {
    expect(parseTimestamp('2026-08-19T11:08:00Z')).toBe(Date.UTC(2026, 7, 19, 11, 8, 0));
    expect(parseTimestamp('2026-08-19T11:08:00+02:00')).toBe(Date.UTC(2026, 7, 19, 9, 8, 0));
  });

  it('falls back to the pretty "%d.%m.%Y, %H:%M" format as local time', () => {
    expect(parseTimestamp('19.08.2026, 11:08')).toBe(new Date(2026, 7, 19, 11, 8, 0).getTime());
  });

  it('accepts optional seconds and a single-digit hour in the pretty format', () => {
    expect(parseTimestamp('19.08.2026, 11:08:30')).toBe(new Date(2026, 7, 19, 11, 8, 30).getTime());
    expect(parseTimestamp('25.12.2026, 9:05')).toBe(new Date(2026, 11, 25, 9, 5, 0).getTime());
  });

  it('trims surrounding whitespace for the pretty format', () => {
    expect(parseTimestamp('  19.08.2026, 11:08  ')).toBe(new Date(2026, 7, 19, 11, 8).getTime());
  });

  // BUG: V8's Date.parse accepts "01.02.2026, 9:05" natively as MM.DD.YYYY
  // (January 2nd), so the DD.MM fallback never runs for days <= 12 and the
  // day/month end up swapped. See alarmUtils.ts:80.
  it('parses a pretty date with day <= 12 as DD.MM', () => {
    expect(parseTimestamp('01.02.2026, 9:05')).toBe(new Date(2026, 1, 1, 9, 5).getTime());
  });

  it('rejects impossible pretty dates instead of rolling them over', () => {
    expect(parseTimestamp('31.02.2026, 10:00')).toBeNull();
  });

  it('returns null for garbage', () => {
    expect(parseTimestamp('not a date')).toBeNull();
    expect(parseTimestamp('19.08.26, 11:08')).toBeNull();
  });
});

describe('alarmStartTime', () => {
  const triggered = '2026-08-19T10:00:00Z';
  const fetched = '2026-08-19T11:00:00Z';
  const updated = '2026-08-19T12:00:00Z';

  it('prefers triggered_at', () => {
    expect(
      alarmStartTime({ triggered_at: triggered, last_fetched: fetched, last_updated: updated }),
    ).toBe(Date.parse(triggered));
  });

  it('falls back to last_fetched, then last_updated (legacy alarms)', () => {
    expect(alarmStartTime({ triggered_at: null, last_fetched: fetched, last_updated: updated })).toBe(
      Date.parse(fetched),
    );
    expect(alarmStartTime({ last_updated: updated })).toBe(Date.parse(updated));
  });

  it('skips unparseable timestamps in the fallback chain', () => {
    expect(alarmStartTime({ triggered_at: 'garbage', last_fetched: fetched })).toBe(
      Date.parse(fetched),
    );
  });

  it('returns null when nothing is parseable', () => {
    expect(alarmStartTime({})).toBeNull();
    expect(alarmStartTime({ triggered_at: 'x', last_fetched: '', last_updated: null })).toBeNull();
  });
});

describe('isAlarmActive', () => {
  it('uses the backend is_active flag when present', () => {
    expect(isAlarmActive({ is_active: true, normalized_at: '2026-08-19T10:00:00Z' })).toBe(true);
    expect(isAlarmActive({ is_active: false, normalized_at: null })).toBe(false);
  });

  it('derives activity from normalized_at when the flag is missing', () => {
    expect(isAlarmActive({})).toBe(true);
    expect(isAlarmActive({ is_active: null, normalized_at: null })).toBe(true);
    expect(isAlarmActive({ normalized_at: '2026-08-19T10:00:00Z' })).toBe(false);
  });

  it('treats an unparseable normalized_at as still active', () => {
    expect(isAlarmActive({ normalized_at: 'garbage' })).toBe(true);
  });
});

describe('alarmRainSpans', () => {
  const start = '2026-08-19T10:00:00Z';
  const startMs = Date.parse(start);

  it('returns [] when there are no rain events', () => {
    expect(alarmRainSpans({})).toEqual([]);
    expect(alarmRainSpans({ rain_events: null })).toEqual([]);
    expect(alarmRainSpans({ rain_events: [] })).toEqual([]);
  });

  it('converts the duration in hours into an end time', () => {
    expect(alarmRainSpans({ rain_events: [{ start, duration: 2, amount: 4.5 }] })).toEqual([
      { start: startMs, end: startMs + 2 * HOUR_MS, amount: 4.5 },
    ]);
  });

  it('supports fractional durations', () => {
    const [span] = alarmRainSpans({ rain_events: [{ start, duration: 0.5, amount: 1 }] });
    expect(span.end - span.start).toBe(HOUR_MS / 2);
  });

  it('returns one span per valid event, in input order', () => {
    const later = '2026-08-20T10:00:00Z';
    const spans = alarmRainSpans({
      rain_events: [
        { start, duration: 1, amount: 1 },
        { start: later, duration: 3, amount: 2 },
      ],
    });
    expect(spans).toHaveLength(2);
    expect(spans[1]).toEqual({ start: Date.parse(later), end: Date.parse(later) + 3 * HOUR_MS, amount: 2 });
  });

  it('skips events with a missing/invalid start or a non-positive/invalid duration', () => {
    expect(
      alarmRainSpans({
        rain_events: [
          { start: null, duration: 1, amount: 1 },
          { start: 'garbage', duration: 1, amount: 1 },
          { start, duration: 0, amount: 1 },
          { start, duration: -2, amount: 1 },
          { start, duration: null, amount: 1 },
        ],
      }),
    ).toEqual([]);
  });

  it('keeps the span but nulls a non-numeric amount', () => {
    const [span] = alarmRainSpans({
      rain_events: [{ start, duration: 1, amount: Number.NaN }],
    });
    expect(span.amount).toBeNull();
    expect(span.start).toBe(startMs);
  });

  // BUG: Number(null) === 0, so a missing amount is reported as 0 mm instead
  // of null (alarmUtils.ts:157).
  it('nulls a missing amount', () => {
    const [span] = alarmRainSpans({ rain_events: [{ start, duration: 1, amount: null }] });
    expect(span.amount).toBeNull();
  });
});

describe('alarmSensors', () => {
  it('returns the over-threshold pairs when present', () => {
    const pairs = [
      { sensor_id: 1, max_value: 120 },
      { sensor_id: 2, max_value: 150 },
    ];
    expect(alarmSensors({ sensor_id: 9, max_value: 999, sensor_max_values: pairs })).toBe(pairs);
  });

  it('falls back to the single strongest sensor for legacy alarms', () => {
    expect(alarmSensors({ sensor_id: 3, max_value: 110 })).toEqual([{ sensor_id: 3, max_value: 110 }]);
    expect(alarmSensors({ sensor_id: 3, max_value: 110, sensor_max_values: [] })).toEqual([
      { sensor_id: 3, max_value: 110 },
    ]);
  });

  it('fills the missing half of the legacy pair with null', () => {
    expect(alarmSensors({ sensor_id: 3 })).toEqual([{ sensor_id: 3, max_value: null }]);
    expect(alarmSensors({ max_value: 0 })).toEqual([{ sensor_id: null, max_value: 0 }]);
  });

  it('returns [] when there is no sensor information at all', () => {
    expect(alarmSensors({})).toEqual([]);
    expect(alarmSensors({ sensor_id: null, max_value: null })).toEqual([]);
  });
});

describe('alarmPeakValue', () => {
  it('prefers the highest value from the max_values history', () => {
    expect(
      alarmPeakValue({
        max_value: 500,
        max_values: [{ value: 120 }, { value: 180 }, { value: 150 }],
        sensor_max_values: [{ sensor_id: 1, max_value: 400 }],
      }),
    ).toBe(180);
  });

  it('ignores non-numeric history entries', () => {
    expect(
      alarmPeakValue({ max_values: [{ value: null }, { value: Number.NaN }, { value: 42 }] }),
    ).toBe(42);
  });

  it('falls back to the highest over-threshold sensor pair', () => {
    expect(
      alarmPeakValue({
        max_value: 10,
        max_values: [],
        sensor_max_values: [
          { sensor_id: 1, max_value: 120 },
          { sensor_id: 2, max_value: 210 },
        ],
      }),
    ).toBe(210);
  });

  it('falls back to the max_value snapshot', () => {
    expect(alarmPeakValue({ max_value: 77 })).toBe(77);
  });

  it('handles negative values', () => {
    expect(alarmPeakValue({ max_values: [{ value: -5 }, { value: -2 }] })).toBe(-2);
  });

  it('returns null when there is no value at all', () => {
    expect(alarmPeakValue({})).toBeNull();
    expect(alarmPeakValue({ max_values: [] })).toBeNull();
  });

  // BUG: Number(null) === 0 is finite, so explicit nulls are read as a peak
  // of 0 instead of "no value" (alarmUtils.ts:207, :214, :223).
  it('treats explicit null values as missing', () => {
    expect(alarmPeakValue({ max_value: null, max_values: [] })).toBeNull();
    expect(alarmPeakValue({ max_values: [{ value: null }] })).toBeNull();
    const legacy = { sensor_id: 1, max_value: null };
    expect(alarmPeakValue(legacy)).toBeNull();
  });
});

describe('alarmHeatColor', () => {
  it('is brand blue when there is no peak value', () => {
    expect(alarmHeatColor({})).toBe(plotTheme.brandBlue);
  });

  it('is brand blue at or below zero heat', () => {
    expect(alarmHeatColor({ threshold: 100, max_value: 0 })).toBe(plotTheme.brandBlue);
    expect(alarmHeatColor({ threshold: 100, max_value: -50 })).toBe(plotTheme.brandBlue);
  });

  it('saturates at brand orange from 3x the threshold upwards', () => {
    expect(alarmHeatColor({ threshold: 100, max_value: 300 })).toBe(plotTheme.brandOrange);
    expect(alarmHeatColor({ threshold: 100, max_value: 10_000 })).toBe(plotTheme.brandOrange);
  });

  it('interpolates between the colour stops', () => {
    // heat 0.5 lies halfway between cyan (0.35) and yellow (0.65):
    // cyan #61aac5 = (97,170,197), yellow #fbbc15 = (251,188,21) -> (174,179,109)
    expect(alarmHeatColor({ threshold: 100, max_value: 150 })).toBe('#aeb36d');
  });

  it('defaults to a threshold of 100 when the threshold is missing or not positive', () => {
    const expected = alarmHeatColor({ threshold: 100, max_value: 150 });
    expect(alarmHeatColor({ max_value: 150 })).toBe(expected);
    expect(alarmHeatColor({ threshold: 0, max_value: 150 })).toBe(expected);
    expect(alarmHeatColor({ threshold: -10, max_value: 150 })).toBe(expected);
  });

  it('scales with the threshold', () => {
    expect(alarmHeatColor({ threshold: 50, max_value: 75 })).toBe('#aeb36d');
  });

  it('uses the max_values history peak over the max_value snapshot', () => {
    expect(alarmHeatColor({ threshold: 100, max_value: 0, max_values: [{ value: 300 }] })).toBe(
      plotTheme.brandOrange,
    );
  });

  it('always returns a 7-character hex colour', () => {
    [0, 10, 35, 99, 105, 150, 195, 250, 299].forEach((value) => {
      expect(alarmHeatColor({ threshold: 100, max_value: value })).toMatch(/^#[0-9a-f]{6}$/);
    });
  });
});
