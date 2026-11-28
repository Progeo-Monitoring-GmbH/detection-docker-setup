import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import type { DeviceKind } from '../../main/locationTypes';

/** The hidden tab loads at the latest this long after the visible one
 * started - a hanging request must not keep it waiting for ever. */
export const PRELOAD_FALLBACK_MS = 10_000;
/** A swipe must go this far sideways... */
export const SWIPE_MIN_PX = 60;
/** ...and be this much more horizontal than vertical (else it's a scroll). */
const SWIPE_RATIO = 2;
/** Set once the user switched a tab - the hint stops then (this browser). */
export const HINT_STORAGE_KEY = 'progeo.deviceKindTabs.switched';
/** Gestures starting in these keep their own meaning: sliders, the plan
 * (pan/zoom, marked data-no-swipe), Plotly in zoom/pan mode. */
export const SWIPE_IGNORE_SELECTOR =
  'input[type="range"], [data-no-swipe], .js-plotly-plot .draglayer';

/** The tab a horizontal swipe (dx, dy in px) leads to: left = the next one,
 * right = the previous one - null for a short or mostly vertical gesture
 * or at the edge. */
export const tabSwipeTarget = (
  kinds: readonly DeviceKind[],
  active: DeviceKind,
  dx: number,
  dy: number,
): DeviceKind | null => {
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= SWIPE_RATIO * Math.abs(dy)) {
    return null;
  }
  const index = kinds.indexOf(active);
  const next = index + (dx < 0 ? 1 : -1);
  return index >= 0 && next >= 0 && next < kinds.length ? kinds[next] : null;
};

/** Whether a gesture starting at `target` belongs to an element that needs
 * horizontal gestures itself (SWIPE_IGNORE_SELECTOR, one that takes its own
 * one-finger drags - touch-action: none, e.g. the plan's tools or the frame
 * slider's selection band - or a horizontally scrolling table) - looked up
 * to `boundary`. */
export const swipeIgnoredAt = (target: EventTarget | null, boundary: Element): boolean => {
  let element = target instanceof Element ? target : null;
  if (element?.closest(SWIPE_IGNORE_SELECTOR)) {
    return true;
  }
  while (element && element !== boundary) {
    const style = window.getComputedStyle(element);
    if (style.touchAction === 'none') {
      return true;
    }
    if (element.scrollWidth > element.clientWidth + 1) {
      const overflow = style.overflowX;
      if (overflow === 'auto' || overflow === 'scroll') {
        return true;
      }
    }
    element = element.parentElement;
  }
  return false;
};

/** Whether this browser switched a tab before (storage may be blocked). */
export const hintDismissed = (): boolean => {
  try {
    return localStorage.getItem(HINT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

export const dismissHint = () => {
  try {
    localStorage.setItem(HINT_STORAGE_KEY, '1');
  } catch {
    // Blocked storage: the hint just comes again next time.
  }
};

/** The active tab, kept in the URL (?tab=climate) so links and escalations
 * keep it. Without it, or with a tab the location doesn't have: the first.
 * The first tab is not written (it's the default). */
export const useDeviceKindTab = (
  kinds: readonly DeviceKind[],
): [DeviceKind, (kind: DeviceKind) => void] => {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const first = kinds[0] ?? 'leak';
  const active = kinds.find((kind) => kind === requested) ?? first;
  const select = useCallback(
    (kind: DeviceKind) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (kind === first) {
            next.delete('tab');
          } else {
            next.set('tab', kind);
          }
          return next;
        },
        { replace: true },
      );
    },
    [first, setSearchParams],
  );
  return [active, select];
};
