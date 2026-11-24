/**
 * Zoom and pan of a plan drawn as an SVG over its image (planViewBox.ts) -
 * as LageplanZoneOverlay does it: Ctrl (or ⌘) + wheel zooms at the cursor,
 * the plain wheel scrolls the page and shows the hint (wheelZoom.tsx), a drag
 * moves the plan, two fingers move and pinch it (one scrolls the page), a
 * double click shows it whole again.
 *
 * The SVG's viewBox is `box` (image pixels); spread `handlers` onto it and
 * give it `touchAction` as style. `ready`: the SVG is mounted (e.g. once the
 * image loaded) - the wheel and touch listeners need the element.
 */
import { type PointerEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isZoomWheel, TWO_FINGER_TOUCH_ACTION, useTwoFingerTouch, useWheelHint } from '../ui/wheelZoom';
import { fullBox, isFull, panBox, type ViewBox, zoomBox } from './planViewBox';

/** A zoom button's step. */
export const ZOOM_STEP = 1.5;
/** Pixels a pointer moves before a press is a drag. */
const DRAG_THRESHOLD = 4;

export const usePlanViewBox = (
  svgRef: RefObject<SVGSVGElement | null>,
  width: number,
  height: number,
  ready = true,
) => {
  const full = fullBox(width, height);
  // null: the whole plan (it follows a new image size).
  const [userBox, setUserBox] = useState<ViewBox | null>(null);
  const box = userBox ?? full;
  const [dragging, setDragging] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  /** Client pixels -> plan units, and how many client pixels a unit is. */
  const toPlan = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM?.();
    if (!svg || !matrix) {
      return null;
    }
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y, pixelsPerUnit: matrix.a };
  };

  const zoomBy = (factor: number, clientX?: number, clientY?: number) => {
    setUserBox((current) => {
      const from = current ?? full;
      const at = clientX != null && clientY != null ? toPlan(clientX, clientY) : null;
      const next = zoomBox(from, factor, at?.x ?? from.x + from.w / 2, at?.y ?? from.y + from.h / 2, full);
      return isFull(next, full) ? null : next;
    });
  };

  // The latest handlers for the native wheel listener (registered once).
  const zoomByRef = useRef(zoomBy);
  useLayoutEffect(() => {
    zoomByRef.current = zoomBy;
  });
  const [wheelHint, showWheelHint] = useWheelHint();
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !ready) {
      return undefined;
    }
    const onWheel = (event: WheelEvent) => {
      if (!isZoomWheel(event)) {
        showWheelHint();
        return;
      }
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomByRef.current(Math.exp(-delta * 0.0015), event.clientX, event.clientY);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [svgRef, showWheelHint, ready]);
  useTwoFingerTouch(svgRef, () => showWheelHint('touch'), ready);

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) {
      return;
    }
    const others = [...pointers.current.entries()].filter(([id]) => id !== event.pointerId);
    if (event.pointerType === 'touch' && others.length === 0) {
      return; // one finger scrolls the page (touch-action)
    }
    if (!dragging && others.length === 0
      && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < DRAG_THRESHOLD) {
      return;
    }
    if (!dragging) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setDragging(true);
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const scale = toPlan(event.clientX, event.clientY)?.pixelsPerUnit;
    if (!scale) {
      return;
    }
    if (others.length === 0) {
      const dx = (event.clientX - previous.x) / scale;
      const dy = (event.clientY - previous.y) / scale;
      setUserBox((current) => {
        const next = panBox(current ?? full, dx, dy, full);
        return isFull(next, full) ? null : next;
      });
      return;
    }
    // Two fingers: zoom by how far apart they moved, around their middle.
    const [, other] = others[0];
    const before = Math.hypot(previous.x - other.x, previous.y - other.y);
    const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
    if (before > 0 && after > 0) {
      zoomBy(after / before, (event.clientX + other.x) / 2, (event.clientY + other.y) / 2);
    }
  };

  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) {
      setDragging(false);
    }
  };

  return {
    box,
    zoomed: userBox !== null,
    dragging,
    wheelHint,
    zoomBy,
    reset: () => setUserBox(null),
    touchAction: TWO_FINGER_TOUCH_ACTION,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onDoubleClick: () => setUserBox(null),
    },
  };
};
