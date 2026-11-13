/**
 * Chart settings of the staff insight pages (database usage, user activity).
 *
 * Colours checked with the dataviz palette validator (light surface):
 * SERIES + ACCENT pass every categorical check - SERIES is a lighter step of
 * the brand blue (#094b81 is darker than the series lightness band). STATUS
 * is the fixed status palette (good / warning / serious / critical): never a
 * series colour, always shown with its label and icon. SEQUENTIAL is one
 * hue, light -> dark.
 */
import type { Config } from 'plotly.js';

export const SERIES = '#1f62a3';
export const ACCENT = '#eb633b';
export const INK = '#3f3f3c';
export const MUTED = '#6b6a64';
export const GRID = '#e1e0d9';
export const AXIS = '#c3c2b7';

export const STATUS_COLORS = {
  active: '#0ca30c',
  stale: '#fab219',
  no_measurements: '#ec835a',
  no_devices: '#d03b3b',
  error: '#8a8984',
} as const;

export const SEQUENTIAL: Array<[number, string]> = [
  [0, '#f3f6fa'],
  [0.25, '#cfdff0'],
  [0.5, '#8fb5dc'],
  [0.75, '#4a84c0'],
  [1, '#0b3659'],
];

export const plotConfig: Partial<Config> = { responsive: true, displaylogo: false, displayModeBar: false };

const axis = {
  gridcolor: GRID,
  linecolor: AXIS,
  zeroline: false,
  automargin: true,
  tickfont: { color: MUTED, size: 11 },
  title: { font: { color: MUTED, size: 12 } },
};

/**
 * The layout every chart starts from: transparent, hairline grid and axis,
 * no legend (a single series needs none - pass `showlegend` with more),
 * white tooltips. Plotly's typings lag behind (barcornerradius), hence the
 * loose record.
 */
export const baseLayout = (height: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  height,
  margin: { l: 8, r: 12, t: 8, b: 8 },
  paper_bgcolor: 'transparent',
  plot_bgcolor: 'transparent',
  font: { family: 'inherit', size: 12, color: INK },
  showlegend: false,
  bargap: 0.25,
  barcornerradius: 4,
  hoverlabel: { bgcolor: '#ffffff', bordercolor: AXIS, font: { color: INK, size: 12 } },
  ...overrides,
  xaxis: { ...axis, ...((overrides.xaxis as object) ?? {}) },
  yaxis: { ...axis, ...((overrides.yaxis as object) ?? {}) },
});

/** 95 s -> "1 min 35 s", 3 h 4 min -> "3 h 04 min". */
export const formatDuration = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(ms)) {
    return '–';
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
  }
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
};

export const formatBytes = (bytes: number | null | undefined) => {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) {
    return '–';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
};

/** The middle value (0 without values). */
export const median = (values: number[]) => {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
