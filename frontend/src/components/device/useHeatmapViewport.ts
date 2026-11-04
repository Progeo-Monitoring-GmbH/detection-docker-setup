import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { fitView, MAX_ZOOM, MIN_ZOOM, panBy, zoomAt, type View, type WorldRect } from './heatmapCanvas';
import { canvasHeightFor, COLORBAR_SPACE } from './heatmapChart';
import { isZoomWheel } from '../ui/wheelZoom';

/**
 * Size and view of the heatmap canvas: its width follows the wrapper
 * (`wrapRef`), its height the content (canvasHeightFor). `view` is the
 * user's zoom/pan, else the view fitted to `bounds` - new bounds (a new
 * plan, other sensors) start from the fitted view again. Null bounds: no
 * chart (nothing to measure).
 */
export const useHeatmapViewport = ({
  bounds,
  height,
  fitPlan,
}: {
  bounds: WorldRect | null;
  height: number;
  fitPlan: boolean;
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const hasChart = bounds != null;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) {
      return undefined;
    }
    const measure = () => setWidth(wrap.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [hasChart]);

  const canvasHeight = canvasHeightFor(bounds, width, height, fitPlan);
  // A readable margin that follows the card's width (8-28 px) instead of a
  // fixed fraction of the plan: small in the narrow /status card, larger in
  // the wide /analyse card, never a huge empty band.
  const viewPadding = width > 0 ? Math.round(Math.min(28, Math.max(8, width * 0.02))) : 12;
  const fitted = useMemo(
    () =>
      bounds && width > 0
        ? fitView(bounds, width, canvasHeight, COLORBAR_SPACE, viewPadding)
        : null,
    [bounds, width, canvasHeight, viewPadding],
  );

  // The user's view, for the bounds it was made on.
  const boundsKey = bounds ? `${bounds.left}:${bounds.top}:${bounds.right}:${bounds.bottom}` : '';
  const [userView, setUserView] = useState<{ boundsKey: string; view: View } | null>(null);
  const zoomed = userView?.boundsKey === boundsKey ? userView.view : null;
  const view = zoomed ?? fitted;

  /** Sets the user's view; null: back to the fitted one. */
  const setView = useCallback(
    (next: View | null) => setUserView(next ? { boundsKey, view: next } : null),
    [boundsKey],
  );

  const zoomBy = useCallback(
    (factor: number, sx?: number, sy?: number) => {
      if (!view) {
        return;
      }
      const fittedScale = fitted?.scale ?? 1;
      setView(
        zoomAt(
          view,
          factor,
          sx ?? width / 2,
          sy ?? canvasHeight / 2,
          fittedScale * MIN_ZOOM,
          fittedScale * MAX_ZOOM,
        ),
      );
    },
    [view, fitted, width, canvasHeight, setView],
  );

  return { wrapRef, width, canvasHeight, view, isZoomed: zoomed != null, setView, zoomBy };
};

/**
 * Pointer input of the heatmap canvas: drag to move, pinch to zoom (around
 * the fingers' middle), hover reports to `onHover`, leaving or dragging to
 * `onLeave`, a click (no drag, one pointer) to `onTap`. Ctrl (or ⌘) + wheel
 * (isZoomWheel) zooms around the cursor - but only where `wheelZoomsAt` says
 * so (over the drawn plan); the plain wheel scrolls the page, over the plan
 * calling `onPlainWheel` (the hint how to zoom). While zooming it must not
 * scroll the page (React's wheel listener is passive, hence addEventListener).
 */
/** A dragged rectangle (screen pixels): start and current corner. */
export type AreaRect = [number, number, number, number];

/** How far (px) a drag must go to select an area - less is a click. */
const MIN_AREA_DRAG = 4;

export const usePanZoomGestures = ({
  enabled,
  view,
  setView,
  zoomBy,
  onHover,
  onLeave,
  onTap,
  wheelZoomsAt,
  onPlainWheel,
  area,
}: {
  /** Whether the canvas is rendered. */
  enabled: boolean;
  view: View | null;
  setView: (view: View) => void;
  zoomBy: (factor: number, sx?: number, sy?: number) => void;
  onHover: (sx: number, sy: number) => void;
  onLeave: () => void;
  onTap?: (sx: number, sy: number) => void;
  wheelZoomsAt: (sx: number, sy: number) => boolean;
  onPlainWheel?: () => void;
  /**
   * Area selection: a drag that `starts` (e.g. with Shift, or in a select
   * mode) draws a rectangle instead of moving the plan - `onChange` while
   * dragging (null when done), `onSelect` with the final one.
   */
  area?: {
    starts: (event: { shiftKey: boolean }) => boolean;
    onChange: (rect: AreaRect | null) => void;
    onSelect: (rect: AreaRect) => void;
  };
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Active pointers (mouse, pen, fingers) for dragging and pinching.
  const pointers = useRef(new Map<number, [number, number]>());
  const dragged = useRef(false);
  const [grabbing, setGrabbing] = useState(false);
  // The area being dragged: the pointer and its start.
  const areaDrag = useRef<{ pointerId: number; start: [number, number]; rect: AreaRect } | null>(null);

  const localPoint = (event: { clientX: number; clientY: number }): [number, number] => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? [event.clientX - rect.left, event.clientY - rect.top] : [0, 0];
  };

  /** Pinch: zoom by the change of the finger distance, around their middle. */
  const pinch = (pointerId: number, point: [number, number], previous: [number, number]) => {
    const [, other] = [...pointers.current.entries()].find(([id]) => id !== pointerId)!;
    const before = Math.hypot(previous[0] - other[0], previous[1] - other[1]);
    const after = Math.hypot(point[0] - other[0], point[1] - other[1]);
    pointers.current.set(pointerId, point);
    if (before > 0) {
      zoomBy(after / before, (point[0] + other[0]) / 2, (point[1] + other[1]) / 2);
    }
    dragged.current = true;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (area && pointers.current.size === 0 && area.starts(event)) {
      event.currentTarget.setPointerCapture(event.pointerId);
      const start = localPoint(event);
      areaDrag.current = { pointerId: event.pointerId, start, rect: [...start, ...start] };
      onLeave();
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, localPoint(event));
    dragged.current = false;
    setGrabbing(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = localPoint(event);
    const drag = areaDrag.current;
    if (drag && drag.pointerId === event.pointerId) {
      drag.rect = [...drag.start, ...point];
      area?.onChange(drag.rect);
      return;
    }
    const previous = pointers.current.get(event.pointerId);
    if (!previous) {
      onHover(point[0], point[1]);
      return;
    }
    if (!view) {
      return;
    }
    if (pointers.current.size >= 2) {
      pinch(event.pointerId, point, previous);
      return;
    }
    const dx = point[0] - previous[0];
    const dy = point[1] - previous[1];
    // A click shouldn't move the plan.
    if (!dragged.current && Math.hypot(dx, dy) < 3) {
      return;
    }
    dragged.current = true;
    pointers.current.set(event.pointerId, point);
    onLeave();
    setView(panBy(view, dx, dy));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = areaDrag.current;
    if (drag && drag.pointerId === event.pointerId) {
      areaDrag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      area?.onChange(null);
      const [x0, y0, x1, y1] = drag.rect;
      if (event.type === 'pointerup' && Math.hypot(x1 - x0, y1 - y0) >= MIN_AREA_DRAG) {
        area?.onSelect(drag.rect);
      } else if (event.type === 'pointerup') {
        onTap?.(x1, y1);
      }
      return;
    }
    const tapped = !dragged.current && pointers.current.size === 1 && pointers.current.has(event.pointerId);
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setGrabbing(pointers.current.size > 0);
    if (tapped && event.type === 'pointerup') {
      const [sx, sy] = localPoint(event);
      onTap?.(sx, sy);
    }
  };

  const onPointerLeave = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!pointers.current.has(event.pointerId)) {
      onLeave();
    }
  };

  // The wheel listener stays registered; it reads the latest callbacks.
  const wheelRef = useRef({ zoomBy, wheelZoomsAt, onPlainWheel });
  useLayoutEffect(() => {
    wheelRef.current = { zoomBy, wheelZoomsAt, onPlainWheel };
  });
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!enabled || !canvas) {
      return undefined;
    }
    const onWheel = (event: WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      if (!wheelRef.current.wheelZoomsAt(sx, sy)) {
        return; // the page scrolls
      }
      if (!isZoomWheel(event)) {
        wheelRef.current.onPlainWheel?.();
        return; // the page scrolls
      }
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      wheelRef.current.zoomBy(Math.exp(-delta * 0.0015), sx, sy);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [enabled]);

  return {
    canvasRef,
    grabbing,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onPointerLeave,
    },
  };
};
