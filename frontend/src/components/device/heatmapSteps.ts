/**
 * Time window and step of the plan (heatmap and overlays): each frame holds
 * every sensor's highest value within one step. The location's whole
 * history is loaded once in a fine base step (GET .../heatmap/?from=&to=&step=,
 * see LocationViewSet._step_frames) and every range/step is cut out of it in
 * the browser (heatmapData.ts). Kept free of React so it can be tested.
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

/** Frames one range shows at most (slider, video export). */
const HEATMAP_MAX_FRAMES = 2000;
/** Frames of a range's default step at most - enough to follow a leak,
 * few enough to step through. */
const DEFAULT_MAX_FRAMES = 200;
/** Frames of the one full-history request at most (the backend's
 * HEATMAP_MAX_FRAMES) - its base step is the finest that stays below. */
const BASE_MAX_FRAMES = 20000;
/** Possible base steps: each divides every coarser step of HEATMAP_STEPS
 * (a 4 h base would not add up to 6 h frames). */
const BASE_STEPS = [30 * 60, 60 * 60, 2 * 60 * 60, 24 * 60 * 60];

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

/** The base step for a history from `first` to `last` (ms). */
export const baseStepFor = (first: number, last: number) =>
  BASE_STEPS.find((step) => frameCount(alignDown(first, step * 1000), last, step) <= BASE_MAX_FRAMES) ??
  BASE_STEPS[BASE_STEPS.length - 1];

/** The window of the full-history request: every measurement, in base steps. */
export const historyWindow = (first: number, last: number): HeatmapWindow => {
  const step = baseStepFor(first, last);
  const stepMs = step * 1000;
  const from = alignDown(first, stepMs);
  return { from, to: Math.max(alignUp(last, stepMs), from + stepMs), step };
};

/** Steps the loaded history can be grouped into: multiples of its base step. */
export const stepFits = (stepSeconds: number, baseStep: number | null | undefined) =>
  !baseStep || (stepSeconds >= baseStep && stepSeconds % baseStep === 0);

/** The steps offered for a range of `days`: groupable from the history,
 * shorter than the range, at most HEATMAP_MAX_FRAMES frames. */
export const stepsForRange = (days: number, baseStep: number | null | undefined) =>
  HEATMAP_STEPS.filter(
    (step) =>
      stepFits(step.seconds, baseStep) &&
      step.seconds < days * 86400 &&
      frameCount(0, days * DAY_MS, step.seconds) <= HEATMAP_MAX_FRAMES,
  );

/** A range's step until the user picks one: the finest offered step with at
 * most DEFAULT_MAX_FRAMES frames (24 h: 30 min, 7 days: 1 h, 30 days: 4 h,
 * 1 year: 2 days, 3 years: 7 days). */
export const defaultStepForRange = (days: number, baseStep: number | null | undefined) => {
  const steps = stepsForRange(days, baseStep);
  return (
    steps.find((step) => frameCount(0, days * DAY_MS, step.seconds) <= DEFAULT_MAX_FRAMES) ??
    steps[steps.length - 1] ??
    HEATMAP_STEPS[HEATMAP_STEPS.length - 1]
  ).seconds;
};

/** The window's frames start on a step boundary (local time), so frames of a
 * day step are whole days. */
const alignedFrom = (window: HeatmapWindow) => alignDown(window.from, window.step * 1000);

export const heatmapQuery = (window: HeatmapWindow) =>
  `from=${encodeURIComponent(new Date(alignedFrom(window)).toISOString())}` +
  `&to=${encodeURIComponent(new Date(window.to).toISOString())}&step=${window.step}`;
