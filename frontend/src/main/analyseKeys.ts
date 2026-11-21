/**
 * /analyse: which page keys a keydown is (useAnalyseHotkeys.ts) - the frame
 * steps (arrows), the Lageplan keys 1-9 and C (clear the picked span).
 */
import { frameAt } from '../components/device/FrameSlider';

/** Frame steps of the arrow keys: ←/→ one frame, ↑/↓ ten. */
const FRAME_KEY_STEPS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: 10,
  ArrowDown: -10,
};

/** Keys typed into a form control keep their normal meaning. */
const isFormTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  // The frame slider is a range input: the global handler owns its arrows
  // too (preventing the browser's own one-step move, so ↑/↓ can do 10).
  if (target instanceof HTMLInputElement && target.type === 'range') {
    return false;
  }
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
};

type PageKeyEvent = Pick<
  KeyboardEvent,
  | 'key'
  | 'repeat'
  | 'defaultPrevented'
  | 'isComposing'
  | 'ctrlKey'
  | 'altKey'
  | 'metaKey'
  | 'shiftKey'
  | 'target'
>;

/** A key the page may handle: not handled yet, not composing, no Ctrl / Alt
 * / Meta, not typed into a form control. */
const isPageKey = (event: PageKeyEvent) =>
  !(
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    isFormTarget(event.target)
  );

/** The frame step of an arrow key (FRAME_KEY_STEPS) - null for other keys,
 * with Shift, or when the page must not handle it. */
export const frameKeyStep = (event: PageKeyEvent): number | null => {
  const step = FRAME_KEY_STEPS[event.key];
  return step != null && !event.shiftKey && isPageKey(event) ? step : null;
};

/** The time (epoch ms) of the frame `step` frames from the shown one (null:
 * the newest), kept within the frames; null when that is the shown one. */
export const steppedFrameTime = (
  frameSeconds: number[],
  frameTime: number | null,
  step: number,
): number | null => {
  const last = frameSeconds.length - 1;
  const current = frameTime == null ? last : frameAt(frameSeconds, frameTime);
  const next = Math.min(Math.max(current + step, 0), last);
  return next !== current ? frameSeconds[next] * 1000 : null;
};

/** 1-9: the index of the Lageplan to show - null for other keys, a plan
 * that does not exist, a held key or when the page must not handle it. */
export const planKeyIndex = (
  event: PageKeyEvent,
  planCount: number,
): number | null => {
  const index = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
  return index >= 0 && index < planCount && !event.repeat && isPageKey(event)
    ? index
    : null;
};

/** C (not Ctrl+C - copy): clear the span picked for a new profile. */
export const isRangeClearKey = (event: PageKeyEvent) =>
  event.key.toLowerCase() === 'c' && !event.repeat && isPageKey(event);
