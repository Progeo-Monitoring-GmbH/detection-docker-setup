/**
 * Time window and step of the heatmap (GET .../heatmap/?from=&to=&step=,
 * see LocationViewSet._step_frames): each frame holds every sensor's highest
 * value within one step. Kept free of React so it can be tested.
 */

export type HeatmapStep = { key: string; seconds: number };

export const HEATMAP_STEPS: readonly HeatmapStep[] = [
  { key: '30m', seconds: 30 * 60 },
  { key: '1h', seconds: 60 * 60 },
  { key: '2h', seconds: 2 * 60 * 60 },
  { key: '4h', seconds: 4 * 60 * 60 },
  { key: '6h', seconds: 6 * 60 * 60 },
  { key: '1d', seconds: 24 * 60 * 60 },
  { key: '2d', seconds: 2 * 24 * 60 * 60 },
  { key: '7d', seconds: 7 * 24 * 60 * 60 },
  { key: '14d', seconds: 14 * 24 * 60 * 60 },
];

/** The backend's HEATMAP_MAX_FRAMES. */
export const HEATMAP_MAX_FRAMES = 2000;
/** Resolution of the window slider. */
export const WINDOW_GRID_MS = 30 * 60 * 1000;
export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_STEP_SECONDS = 60 * 60;

export type HeatmapWindow = { from: number; to: number; step: number };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local time zone offset of a moment, in ms (positive east of UTC). */
const localOffset = (ms: number) => -new Date(ms).getTimezoneOffset() * 60 * 1000;

/** `ms` rounded down to a multiple of `stepMs` in local time - a day step
 * starts at local midnight, an hour step on the full hour. */
export const alignDown = (ms: number, stepMs: number) => {
  const offset = localOffset(ms);
  return Math.floor((ms + offset) / stepMs) * stepMs - offset;
};

export const alignUp = (ms: number, stepMs: number) => {
  const down = alignDown(ms, stepMs);
  return down === ms ? ms : alignDown(ms + stepMs, stepMs);
};

export const frameCount = (from: number, to: number, stepSeconds: number) =>
  Math.max(0, Math.ceil((to - from) / (stepSeconds * 1000)));

/** The last DEFAULT_WINDOW_DAYS before `newest` (the newest measurement, or
 * now) in hourly steps. */
export const defaultWindow = (newest: number): HeatmapWindow => {
  const to = alignUp(newest, WINDOW_GRID_MS);
  return {
    from: alignDown(to - DEFAULT_WINDOW_DAYS * DAY_MS, DEFAULT_STEP_SECONDS * 1000),
    to,
    step: DEFAULT_STEP_SECONDS,
  };
};

/** The window's frames start on a step boundary (local time), so frames of a
 * day step are whole days. */
export const alignedFrom = (window: HeatmapWindow) => alignDown(window.from, window.step * 1000);

export const heatmapQuery = (window: HeatmapWindow) =>
  `from=${encodeURIComponent(new Date(alignedFrom(window)).toISOString())}` +
  `&to=${encodeURIComponent(new Date(window.to).toISOString())}&step=${window.step}`;
