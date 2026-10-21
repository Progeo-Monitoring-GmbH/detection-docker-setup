/**
 * Zoom and pan of the plan overlay (LageplanZoneOverlay) as its SVG viewBox:
 * the part of the plan image (image pixels) that is shown. Zooming keeps the
 * point under the cursor in place; the box never leaves the image.
 */

export type ViewBox = { x: number; y: number; w: number; h: number };

/** How far in the plan can be zoomed (box width : image width). */
export const MAX_ZOOM = 20;

export const fullBox = (width: number, height: number): ViewBox => ({ x: 0, y: 0, w: width, h: height });

export const isFull = (box: ViewBox, full: ViewBox) => box.w >= full.w && box.h >= full.h;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** The box moved back onto the image. */
const keepInside = (box: ViewBox, full: ViewBox): ViewBox => ({
  ...box,
  x: clamp(box.x, full.x, full.x + full.w - box.w),
  y: clamp(box.y, full.y, full.y + full.h - box.h),
});

/** Zoomed by `factor` (> 1: in) around the plan point (px, py). */
export const zoomBox = (box: ViewBox, factor: number, px: number, py: number, full: ViewBox): ViewBox => {
  const w = clamp(box.w / factor, full.w / MAX_ZOOM, full.w);
  const ratio = w / box.w;
  return keepInside(
    { x: px - (px - box.x) * ratio, y: py - (py - box.y) * ratio, w, h: box.h * ratio },
    full,
  );
};

/** Moved by (dx, dy) plan units - the plan follows the pointer. */
export const panBox = (box: ViewBox, dx: number, dy: number, full: ViewBox): ViewBox =>
  keepInside({ ...box, x: box.x - dx, y: box.y - dy }, full);

export const viewBoxAttribute = (box: ViewBox) => `${box.x} ${box.y} ${box.w} ${box.h}`;
