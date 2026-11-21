import { type KeyboardEvent, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { columnWidthOf } from '../components/device/sensorColumns';
import { useWheelHint, useZoomWheel } from '../components/ui/wheelZoom';
import { keyScrollOf, type ScrollState } from './thresholdMixerView';

/**
 * The mixer's horizontal scroller of `count` columns: its width decides the
 * column width, Ctrl/⌘ + wheel zooms the columns (the plain wheel shows the
 * hint), ←/→ scroll, and `scroll` says where it stands. `loading` swaps the
 * scroller's element (spinner / plot), so the observers attach again.
 */
const useThresholdMixerScroller = (count: number, loading: boolean) => {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const [zoomColumn, setZoomColumn] = useState<number | null>(null);
  const [scroll, setScroll] = useState<ScrollState>({ left: 0, client: 0, total: 0 });
  const [wheelHint, showWheelHint] = useWheelHint();

  // The scroller's width decides the column width.
  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(() => setWidth(element.clientWidth || 800));
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading]);

  const column = columnWidthOf(width, count, zoomColumn);
  const plotWidth = Math.max(width, column * count);

  const measureScroll = useCallback(() => {
    const element = scrollerRef.current;
    if (element) {
      setScroll({ left: element.scrollLeft, client: element.clientWidth, total: element.scrollWidth });
    }
  }, []);
  useLayoutEffect(measureScroll, [measureScroll, plotWidth, loading]);

  const scrollBy = (pixels: number) => {
    const element = scrollerRef.current;
    if (!element) {
      return;
    }
    if (typeof element.scrollBy === 'function') {
      element.scrollBy({ left: pixels, behavior: 'smooth' });
    } else {
      element.scrollLeft += pixels;
    }
  };

  useZoomWheel(
    scrollerRef,
    (event) => {
      const factor = event.deltaY < 0 ? 1.25 : 0.8;
      setZoomColumn((current) => (current ?? column) * factor);
    },
    showWheelHint,
    [loading],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const distance = keyScrollOf(event.key, event.shiftKey, scroll.client, column);
    if (distance != null) {
      event.preventDefault();
      scrollBy(distance);
    }
  };

  return {
    scrollerRef,
    column,
    plotWidth,
    scroll,
    scrollBy,
    wheelHint,
    /** Spread on the scroller element. */
    scrollerProps: { ref: scrollerRef, onKeyDown, onScroll: measureScroll },
  };
};

export default useThresholdMixerScroller;
