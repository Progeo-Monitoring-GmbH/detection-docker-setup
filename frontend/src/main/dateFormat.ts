import i18next from 'i18next';
import { parseTimestamp } from './alarmUtils';

/**
 * The one way dates are shown in the frontend: formatDate(value, format) in
 * the user's language (i18next), one of the named formats below so the same
 * kind of date looks the same everywhere. Our pretty format ("19.08.2026,
 * 11:08", de-DE) is only the fallback - for a language Intl doesn't know.
 */

const DAY_MONTH = { day: '2-digit', month: '2-digit' } as const;
const DATE = { ...DAY_MONTH, year: 'numeric' } as const;
const TIME = { hour: '2-digit', minute: '2-digit' } as const;

export const DATE_FORMATS = {
  dateTime: { ...DATE, ...TIME },
  dateTimeSeconds: { ...DATE, ...TIME, second: '2-digit' },
  date: DATE,
  time: TIME,
  timeSeconds: { ...TIME, second: '2-digit' },
  /** Without the year - timelines, cursors. */
  dayMonthTime: { ...DAY_MONTH, ...TIME },
  dayMonth: DAY_MONTH,
  weekdayDate: { weekday: 'short', ...DATE },
  weekdayDayMonth: { weekday: 'short', ...DAY_MONTH },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

export type DateFormat = keyof typeof DATE_FORMATS;

/** The pretty format's locale - the fallback. */
export const PRETTY_LOCALE = 'de-DE';

/** Placeholder for a missing or unparseable date (never "Invalid Date"). */
export const NO_DATE = '–';

/** The user's language for dates, null when Intl doesn't know it. */
export const dateLocale = (
  language: string | undefined = i18next.resolvedLanguage ?? i18next.language,
): string | null => {
  if (!language || language === 'cimode') {
    return null;
  }
  try {
    return Intl.DateTimeFormat.supportedLocalesOf(language).length ? language : null;
  } catch {
    return null;
  }
};

/** Epoch ms of a Date, epoch ms or date string (ISO or our pretty format). */
const toMs = (value: Date | number | string | null | undefined): number | null => {
  if (value == null || value === '') {
    return null;
  }
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : parseTimestamp(value);
  return ms != null && !Number.isNaN(new Date(ms).getTime()) ? ms : null;
};

/** `value` (Date, epoch ms or date string) as `format` in the user's language - NO_DATE when it isn't a date. */
export const formatDate = (
  value: Date | number | string | null | undefined,
  format: DateFormat = 'dateTime',
): string => {
  const ms = toMs(value);
  if (ms == null) {
    return NO_DATE;
  }
  const date = new Date(ms);
  const options = DATE_FORMATS[format];
  const locale = dateLocale();
  if (locale) {
    try {
      return date.toLocaleString(locale, options);
    } catch {
      // the pretty format
    }
  }
  return date.toLocaleString(PRETTY_LOCALE, options);
};

/** ms -> naive local ISO string (matches the backend from/to params). */
export const toLocalIso = (ms: number): string => {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
};
