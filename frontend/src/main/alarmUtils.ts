import { plotTheme } from '../styles/plotTheme';

export type AlarmLocationLite = {
  id?: number | null;
  project_id?: number | null;
  name?: string | null;
};

export type AlarmDeviceLite = {
  id?: number | null;
  mac?: string | null;
  raw_hash?: string | null;
};

export type AlarmMaxValueEntry = {
  ts?: string | null;
  value?: number | null;
  sensor_id?: number | null;
};

export type TimelineAlarm = {
  id: number;
  location?: AlarmLocationLite | null;
  device?: AlarmDeviceLite | null;
  triggered_at?: string | null;
  last_fetched?: string | null;
  last_updated?: string | null;
  normalized_at?: string | null;
  still_active_at?: string | null;
  evaluated_at?: string | null;
  evaluated_by?: { id?: number | null; username?: string | null } | null;
  is_active?: boolean;
  status?: number;
  sensor_id?: number | null;
  max_value?: number | null;
  threshold?: number | null;
  max_values?: AlarmMaxValueEntry[];
};

/** Format a duration in seconds as "1d 2h 3m 4s" (skips empty units). */
export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '-';
  }
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0 || secs > 0) parts.push(`${secs}s`);
  return parts.join(' ');
};

export const parseTimestamp = (raw?: string | null): number | null => {
  if (!raw) {
    return null;
  }
  // ISO-8601 (preferred, emitted by ProgeoAlarmSerializer).
  const ms = Date.parse(raw);
  if (!Number.isNaN(ms)) {
    return ms;
  }
  // Fallback: the project-wide pretty format "%d.%m.%Y, %H:%M" (e.g.
  // "19.08.2026, 11:08") in case a stale/cached payload shows up.
  const prettyMatch =
    /^(\d{2})\.(\d{2})\.(\d{4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
      raw.trim(),
    );
  if (prettyMatch) {
    const [, day, month, year, hour, minute, second] = prettyMatch;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      second ? Number(second) : 0,
    );
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }
  return null;
};

/**
 * Effective alarm start time in ms. `triggered_at` is the canonical trigger
 * time, but legacy alarms may lack it - fall back to the alarm row's own
 * `last_fetched`/`last_updated` (set whenever the row is saved) so the alarm
 * always gets a position on the timeline.
 */
export const alarmStartTime = (alarm: {
  triggered_at?: string | null;
  last_fetched?: string | null;
  last_updated?: string | null;
}): number | null => {
  return (
    parseTimestamp(alarm.triggered_at) ??
    parseTimestamp(alarm.last_fetched) ??
    parseTimestamp(alarm.last_updated)
  );
};

/**
 * Whether the alarm is still active. Prefers the backend `is_active` flag and
 * falls back to deriving it from `normalized_at` so the UI stays correct even
 * when the payload does not include the flag.
 */
export const isAlarmActive = (alarm: {
  is_active?: boolean | null;
  normalized_at?: string | null;
}): boolean => {
  if (typeof alarm.is_active === 'boolean') {
    return alarm.is_active;
  }
  return parseTimestamp(alarm.normalized_at) == null;
};

/**
 * Highest value ever recorded for this alarm (from the per-measurement
 * development history, falling back to the single `max_value` snapshot).
 */
export const alarmPeakValue = (alarm: {
  max_value?: number | null;
  max_values?: AlarmMaxValueEntry[];
}): number | null => {
  const history = Array.isArray(alarm.max_values) ? alarm.max_values : [];
  const peak = history.reduce<number | null>((best, entry) => {
    const value = Number(entry?.value);
    if (!Number.isFinite(value)) {
      return best;
    }
    return best == null || value > best ? value : best;
  }, null);
  return (
    peak ??
    (Number.isFinite(Number(alarm.max_value)) ? Number(alarm.max_value) : null)
  );
};

/** Hex color -> [r, g, b]. */
const parseHex = (hex: string): [number, number, number] => {
  const normalized = hex.replace('#', '');
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((c) => c + c)
          .join('')
      : normalized;
  const value = Number.parseInt(full, 16);
  if (Number.isNaN(value)) {
    return [9, 75, 129];
  }
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

const toHex = (rgb: [number, number, number]): string =>
  `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Interpolate along the same colorscale the 2D heatmap uses
 * (blue -> cyan -> yellow -> orange) based on how far the peak value is
 * above the alarm threshold. `heat` 0 = at threshold, 1 = HEAT_FULL_MULTIPLIER
 * times the threshold (matching SensorHeatmap2D's saturation point).
 */
export const alarmHeatColor = (alarm: {
  threshold?: number | null;
  max_value?: number | null;
  max_values?: AlarmMaxValueEntry[];
}): string => {
  const rawThreshold = Number(alarm.threshold);
  const threshold =
    Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : 100;
  const peak = alarmPeakValue(alarm);
  const heat =
    peak == null ? 0 : Math.min(1, Math.max(0, peak / (threshold * 3)));

  const stops: Array<[number, string]> = [
    [0, plotTheme.brandBlue],
    [0.35, plotTheme.contrastCyan],
    [0.65, plotTheme.contrastYellow],
    [1, plotTheme.brandOrange],
  ];
  for (let index = 1; index < stops.length; index += 1) {
    const [t0, color0] = stops[index - 1];
    const [t1, color1] = stops[index];
    if (heat <= t1) {
      const t = t1 === t0 ? 0 : (heat - t0) / (t1 - t0);
      const rgb0 = parseHex(color0);
      const rgb1 = parseHex(color1);
      return toHex([
        lerp(rgb0[0], rgb1[0], t),
        lerp(rgb0[1], rgb1[1], t),
        lerp(rgb0[2], rgb1[2], t),
      ]);
    }
  }
  return plotTheme.brandOrange;
};
