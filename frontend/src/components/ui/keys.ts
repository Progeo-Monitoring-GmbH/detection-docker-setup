/**
 * Whether a key event's target takes typed text (input, textarea, select or
 * a contentEditable element) - then a canvas / map shortcut must not fire.
 * Some views let a range input or checkbox through on purpose (FrameSlider,
 * MeasurementSamplesCompareChart, analyseKeys); they keep their own check.
 */
export const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
