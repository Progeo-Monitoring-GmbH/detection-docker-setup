import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Plans and plots zoom with Ctrl (or ⌘) + mouse wheel only - a trackpad pinch
 * sends the same. The plain wheel scrolls the page and shows WheelZoomHint.
 */
export const isZoomWheel = (event: WheelEvent) => event.ctrlKey || event.metaKey;

const HINT_MS = 1400;

/** [hint shown, show it] - shown for a moment after each plain wheel turn. */
export const useWheelHint = (): [boolean, () => void] => {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback(() => {
    setVisible(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), HINT_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [visible, show];
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

/** "Ctrl + scroll to zoom" over a plan or plot (its parent: position relative). */
export const WheelZoomHint = ({ visible, radius = 13 }: { visible: boolean; radius?: number }) =>
  visible ? (
    <div
      aria-live="polite"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 3,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        borderRadius: radius,
        background: 'rgba(16, 20, 25, 0.35)',
        color: '#ffffff',
        fontSize: 15,
        fontWeight: 600,
      }}
    >
      Ctrl + scroll to zoom
    </div>
  ) : null;
