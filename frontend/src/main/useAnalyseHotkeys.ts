import { useEffect } from 'react';
import { announceKey } from '../components/ui/KeyHints';
import {
  frameKeyStep,
  isRangeClearKey,
  planKeyIndex,
  steppedFrameTime,
} from './analyseKeys';

type AnalyseHotkeysOptions = {
  /** The frame slider's frames (epoch s) and its time (null: the newest). */
  frameSeconds: number[];
  frameTime: number | null;
  onFrameTime: (time: number) => void;
  /** Keys 1-9 pick a Lageplan - only while this is set. */
  planHotkeys: boolean;
  plans: readonly { id: number }[];
  onPlan: (id: number) => void;
  /** C clears the span picked for a new profile - only while this is set. */
  rangeClear: boolean;
  onRangeClear: () => void;
};

const listenKeyDown = (onKeyDown: (event: KeyboardEvent) => void) => {
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
};

/**
 * The keys of the Analyse page (analyseKeys.ts): ←/→ one frame, ↑/↓ ten;
 * 1-9 the heatmap's Lageplan (the switcher numbers them); C clears the span
 * picked for a new profile.
 */
const useAnalyseHotkeys = ({
  frameSeconds,
  frameTime,
  onFrameTime,
  planHotkeys,
  plans,
  onPlan,
  rangeClear,
  onRangeClear,
}: AnalyseHotkeysOptions) => {
  useEffect(
    () =>
      listenKeyDown((event) => {
        const step = frameKeyStep(event);
        if (step == null || !frameSeconds.length) {
          return;
        }
        event.preventDefault();
        announceKey(Math.abs(step) === 1 ? 'frame-step' : 'frame-jump');
        const next = steppedFrameTime(frameSeconds, frameTime, step);
        if (next != null) {
          onFrameTime(next);
        }
      }),
    [frameSeconds, frameTime, onFrameTime],
  );

  useEffect(() => {
    if (!planHotkeys) {
      return undefined;
    }
    return listenKeyDown((event) => {
      const index = planKeyIndex(event, plans.length);
      if (index == null) {
        return;
      }
      event.preventDefault();
      announceKey('plan');
      onPlan(plans[index].id);
    });
  }, [planHotkeys, plans, onPlan]);

  useEffect(() => {
    if (!rangeClear) {
      return undefined;
    }
    return listenKeyDown((event) => {
      if (!isRangeClearKey(event)) {
        return;
      }
      event.preventDefault();
      onRangeClear();
      announceKey('range-clear');
    });
  }, [rangeClear, onRangeClear]);
};

export default useAnalyseHotkeys;
