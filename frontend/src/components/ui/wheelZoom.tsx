import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './wheelZoom.css';

/**
 * Plans and plots zoom with Ctrl (or ⌘) + mouse wheel only - a trackpad pinch
 * sends the same. The plain wheel scrolls the page and shows WheelZoomHint.
 *
 * Touch follows the same rule: one finger scrolls the page, two fingers move
 * and zoom the plan (TWO_FINGER_TOUCH_ACTION, useTwoFingerTouch) - otherwise a
 * phone or tablet, where plans and plots fill the screen, can't scroll at all.
 */
export const isZoomWheel = (event: WheelEvent) => event.ctrlKey || event.metaKey;

/**
 * touch-action of a plan or plot: the browser may scroll the page with one
 * finger, but never zoom it - two fingers go to the plan (useTwoFingerTouch).
 * Tools that draw or drag with one finger keep 'none' while they are active.
 */
export const TWO_FINGER_TOUCH_ACTION = 'pan-x pan-y';

const HINT_MS = 1400;

/** Which hint: how to zoom with the wheel, or how to use two fingers. */
export type ZoomHintKind = 'wheel' | 'touch';

/**
 * [hint shown (false or its kind), show it] - shown for a moment after each
 * plain wheel turn (show()) or one-finger touch move (show('touch')).
 */
export const useWheelHint = (): [false | ZoomHintKind, (kind?: ZoomHintKind) => void] => {
  const [visible, setVisible] = useState<false | ZoomHintKind>(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((kind: ZoomHintKind = 'wheel') => {
    setVisible(kind);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), HINT_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [visible, show];
};

/**
 * Touch input of a plan (with touch-action TWO_FINGER_TOUCH_ACTION): two or
 * more fingers never scroll the page - the plan's pointer handlers move and
 * zoom it - one finger scrolls the page and calls `onOneFinger` (the hint).
 * A native listener: React's touch listeners are passive.
 */
export const useTwoFingerTouch = (
  ref: RefObject<Element | null>,
  onOneFinger?: () => void,
  enabled = true,
) => {
  const latest = useRef(onOneFinger);
  useLayoutEffect(() => {
    latest.current = onOneFinger;
  });
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) {
      return undefined;
    }
    const onTouchMove = (event: Event) => {
      if ((event as TouchEvent).touches.length >= 2) {
        event.preventDefault();
        return;
      }
      latest.current?.();
    };
    element.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => element.removeEventListener('touchmove', onTouchMove);
  }, [ref, enabled]);
};

/**
 * A Plotly chart inside `element`: one finger scrolls the page over it.
 * Plotly's drag layer calls preventDefault on every touchstart, so a finger
 * landing on a chart could never scroll - a capture listener hands it the
 * one-finger touches no longer (tap tooltips still come from the mouse events
 * browsers send after a tap). Two fingers still reach Plotly.
 */
export const usePlotlyTouchScroll = (element: HTMLElement | null) => {
  useEffect(() => {
    if (!element) {
      return undefined;
    }
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        event.stopPropagation();
      }
    };
    element.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    return () => element.removeEventListener('touchstart', onTouchStart, { capture: true });
  }, [element]);
};

/** usePlotlyTouchScroll for Plotly charts that keep no reference to their graph div. */
export const PlotlyTouchScroll = ({ children }: { children: ReactNode }) => {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  usePlotlyTouchScroll(element);
  return <div ref={setElement}>{children}</div>;
};

/**
 * Wheel input of a zoomable element: `onZoom` for Ctrl/⌘ + wheel - neither
 * the page nor the browser scrolls or zooms then - `onPlain` for the plain
 * wheel, which scrolls the page. A native listener: React's onWheel is
 * passive and can't prevent anything. `deps`: when the element may change.
 */
export const useZoomWheel = (
  ref: RefObject<HTMLElement | null>,
  onZoom: (event: WheelEvent) => void,
  onPlain?: () => void,
  deps: unknown[] = [],
) => {
  const latest = useRef({ onZoom, onPlain });
  useLayoutEffect(() => {
    latest.current = { onZoom, onPlain };
  });
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }
    const onWheel = (event: WheelEvent) => {
      if (!isZoomWheel(event)) {
        latest.current.onPlain?.();
        return;
      }
      event.preventDefault();
      latest.current.onZoom(event);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller says when the element changes
  }, [ref, ...deps]);
};

/**
 * A Plotly figure (its graph div): over the plots (their drag areas) only
 * Ctrl (or ⌘) + wheel zooms - handed on to Plotly's scrollZoom, neither the
 * page nor the browser zooms. The plain wheel is stopped on the way down,
 * before Plotly's own listener: the page scrolls and `onPlain` shows the hint.
 */
export const usePlotlyWheelZoom = (graphDiv: HTMLElement | null, onPlain: () => void) => {
  useEffect(() => {
    if (!graphDiv) {
      return undefined;
    }
    const onWheel = (event: WheelEvent) => {
      if (!(event.target instanceof Element && event.target.closest('.drag'))) {
        return;
      }
      if (isZoomWheel(event)) {
        event.preventDefault();
        return;
      }
      event.stopPropagation();
      onPlain();
    };
    graphDiv.addEventListener('wheel', onWheel, true);
    return () => graphDiv.removeEventListener('wheel', onWheel, true);
  }, [graphDiv, onPlain]);
};

/**
 * "Ctrl + scroll to zoom" (or, after a one-finger touch, "use two fingers")
 * over a plan or plot (its parent: position relative).
 */
export const WheelZoomHint = ({
  visible,
  radius = 13,
  testId = 'wheel-zoom-hint',
}: {
  visible: boolean | ZoomHintKind;
  radius?: number;
  /** data-testid of the hint - set it when a page shows several zoomable views. */
  testId?: string;
}) => {
  const { t } = useTranslation();
  if (!visible) {
    return null;
  }
  const text =
    visible === 'touch'
      ? t('zoom_hint_touch', 'Use two fingers to move and zoom')
      : t('zoom_hint_wheel', 'Ctrl + scroll to zoom');
  return (
    <div
      aria-live="polite"
      className="wheel-zoom-hint"
      style={{ borderRadius: radius }}
      data-testid={testId}
    >
      {text}
    </div>
  );
};
