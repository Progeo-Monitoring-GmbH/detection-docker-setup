/**
 * Geometry of the plan canvas (ImageCanvasStage): its coordinate systems,
 * where measure points sit on it and what lies under the mouse. Pure - no
 * React, no DOM beyond the sizes handed in.
 *
 * Coordinate systems:
 *  - canvas units: the canvas' own system (CANVAS_HEIGHT high), shown at any
 *    width; pan offsets and stored point offsets are canvas units;
 *  - image pixels: pixels of the plan image (reference point, selections);
 *  - normalized: nx/ny of a measure point (0..1, under the point alignment);
 *  - fraction: 0..1 of the plan image, y down (pins).
 */
import { applyGroup, toFraction, toNormalized, type GroupTransform } from './groupAlign';

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// The canvas' own coordinate system (positions, pan, stored offsets); it is
// drawn at the size it is shown, sharp at any width (see pixelRatio).
export const CANVAS_WIDTH = 900;
export const CANVAS_HEIGHT = 600;
const CANVAS_PADDING = 32;
// The narrowest compact canvas - room for the controls floating on it
// (zoom, rotate, badges, the apply bar).
export const MIN_CANVAS_WIDTH = 560;
// Backing store pixels per canvas unit at most (huge screens / zoomed pages).
const MAX_PIXEL_RATIO = 4;
// Screen pixels: how close the mouse must be to a sensor for its tooltip,
// and the average distance between sensors from which they get labels.
export const HOVER_TOLERANCE = 8;
export const LABEL_SPACING = 34;
export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 20;
/** Zoom per click of the zoom buttons. */
export const ZOOM_STEP = 1.5;
export const SENSOR_RADIUS = 9;
/** Mouse travel (px) up to which a press on the plan still counts as a click. */
export const CLICK_TOLERANCE = 4;
/** Image pixels a selection needs at least (both sides) to be applied. */
const MIN_SELECTION = 2;

export type ImagePoint = [number, number];

/** What the geometry needs of the plan image (an HTMLImageElement). */
export type PlanImage = { naturalWidth: number; naturalHeight: number };

export type AlignmentValues = {
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  flipY: boolean;
};

export const sameAlignment = (a: AlignmentValues, b: AlignmentValues) =>
  a.offsetX === b.offsetX &&
  a.offsetY === b.offsetY &&
  a.scaleX === b.scaleX &&
  a.scaleY === b.scaleY &&
  a.flipY === b.flipY;

/** The alignment a plan stores (offset_x, ...), its defaults filled in. */
export const storedAlignment = (
  meta:
    | { offset_x?: number; offset_y?: number; scale_x?: number; scale_y?: number; flip_y?: boolean }
    | undefined,
  defaultFlipY: boolean,
): AlignmentValues => ({
  offsetX: meta?.offset_x ?? 0,
  offsetY: meta?.offset_y ?? 0,
  scaleX: meta?.scale_x ?? 1,
  scaleY: meta?.scale_y ?? 1,
  flipY: meta?.flip_y ?? defaultFlipY,
});

/** Pan and zoom of the canvas. */
export type PlanView = { zoom: number; offsetX: number; offsetY: number };

/** Colour of the index-th of `count` sensors in sensor order, red to violet:
 * neighbours are told apart, and runs of sensors are easy to follow. */
export const rainbowColor = (index: number, count: number) =>
  `hsl(${count > 1 ? Math.round((index / (count - 1)) * 280) : 0}, 85%, 45%)`;

export const RAINBOW_GRADIENT = `linear-gradient(to right, ${[0, 1, 2, 3, 4]
  .map((step) => rainbowColor(step, 5))
  .join(', ')})`;

/** Where along the segment a..b the point p lies closest (0..1). */
const segmentPosition = ([px, py]: ImagePoint, [ax, ay]: ImagePoint, [bx, by]: ImagePoint) => {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  return lengthSq ? clamp(((px - ax) * dx + (py - ay) * dy) / lengthSq, 0, 1) : 0;
};

export const segmentDistance = (p: ImagePoint, a: ImagePoint, b: ImagePoint) => {
  const t = segmentPosition(p, a, b);
  return Math.hypot(p[0] - (a[0] + t * (b[0] - a[0])), p[1] - (a[1] + t * (b[1] - a[1])));
};

export const finite = (value: unknown) => (value == null || value === '' ? NaN : Number(value));

/**
 * Scale at which the alignment canvas fits a Lageplan of the given size (at
 * zoom 1). A Lageplan's stored offset_x/offset_y are canvas pixels at this
 * scale, so offset_x / (width * alignmentBaseScale(...)) is the offset as a
 * fraction of the image - SensorHeatmap2D uses this to place points the
 * same way.
 */
export const alignmentBaseScale = (imageWidth: number, imageHeight: number) =>
  Math.min((CANVAS_WIDTH - CANVAS_PADDING) / imageWidth, (CANVAS_HEIGHT - CANVAS_PADDING) / imageHeight, 1.5);

/** Image pixel of a normalized point (nx/ny) under the point alignment -
 * where the canvas draws it, independent of zoom and pan. */
export const normalizedToImage = (
  [nx, ny]: [number, number],
  alignment: AlignmentValues,
  width: number,
  height: number,
): [number, number] => {
  const base = alignmentBaseScale(width, height);
  return [
    alignment.offsetX / base + nx * width * alignment.scaleX,
    alignment.offsetY / base + (alignment.flipY ? 1 - ny : ny) * height * alignment.scaleY,
  ];
};

/** Compact: the canvas only as wide as the plan needs at zoom 1 (plus the
 * padding), never narrower than its floating controls need. */
export const compactCanvasWidth = (image: PlanImage | null) =>
  image
    ? clamp(
        Math.ceil(image.naturalWidth * alignmentBaseScale(image.naturalWidth, image.naturalHeight) + CANVAS_PADDING),
        MIN_CANVAS_WIDTH,
        CANVAS_WIDTH,
      )
    : CANVAS_WIDTH;

/** Where the plan is drawn on the canvas (canvas pixels) and at which scale
 * (canvas pixels per image pixel). */
export const canvasLayout = (canvas: { width: number; height: number }, image: PlanImage, view: PlanView) => {
  const scale = alignmentBaseScale(image.naturalWidth, image.naturalHeight) * view.zoom;
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  return {
    scale,
    drawWidth,
    drawHeight,
    drawX: canvas.width / 2 - drawWidth / 2 + view.offsetX,
    drawY: canvas.height / 2 - drawHeight / 2 + view.offsetY,
  };
};

export type CanvasLayout = ReturnType<typeof canvasLayout>;

/** How measure points (normalized nx/ny) sit on the canvas: the plan's
 * layout plus the point alignment (offset/scale/flip of the sliders). */
export type PointTransform = CanvasLayout & AlignmentValues & { zoom: number };

export const pointTransform = (layout: CanvasLayout, alignment: AlignmentValues, zoom: number): PointTransform => ({
  ...layout,
  ...alignment,
  zoom,
});

export const normalizedToCanvas = ([nx, ny]: ImagePoint, t: PointTransform): ImagePoint => [
  t.drawX + t.offsetX * t.zoom + nx * t.drawWidth * t.scaleX,
  t.drawY + t.offsetY * t.zoom + (t.flipY ? 1 - ny : ny) * t.drawHeight * t.scaleY,
];

export const canvasToNormalized = ([x, y]: ImagePoint, t: PointTransform): ImagePoint => {
  const drawnY = (y - t.drawY - t.offsetY * t.zoom) / (t.drawHeight * t.scaleY);
  return [(x - t.drawX - t.offsetX * t.zoom) / (t.drawWidth * t.scaleX), t.flipY ? 1 - drawnY : drawnY];
};

/** Where the plan and its points are drawn - nothing before the image is there. */
export const stageGeometry = (
  logical: { width: number; height: number },
  image: PlanImage | null,
  view: PlanView,
  alignment: AlignmentValues,
) => {
  if (!image) {
    return { layout: null, transform: null };
  }
  const layout = canvasLayout(logical, image, view);
  return { layout, transform: pointTransform(layout, alignment, view.zoom) };
};

/** Backing store pixels per canvas unit: the shown size times the device
 * pixel ratio, at most MAX_PIXEL_RATIO. */
export const pixelRatioFor = (screenScale: number, devicePixelRatio: number | undefined) =>
  Math.min(MAX_PIXEL_RATIO, screenScale * (devicePixelRatio || 1));

/** Image pixel at a canvas point - moved onto the plan with `onPlan`, else
 * null outside it. */
export const canvasToImage = (
  [cx, cy]: ImagePoint,
  layout: CanvasLayout,
  image: PlanImage,
  onPlan = false,
): ImagePoint | null => {
  const x = (cx - layout.drawX) / layout.scale;
  const y = (cy - layout.drawY) / layout.scale;
  if (onPlan) {
    return [clamp(x, 0, image.naturalWidth), clamp(y, 0, image.naturalHeight)];
  }
  return x < 0 || y < 0 || x > image.naturalWidth || y > image.naturalHeight ? null : [x, y];
};

/** Image pixel -> canvas unit. */
export const imageToCanvas = ([x, y]: ImagePoint, layout: CanvasLayout): ImagePoint => [
  layout.drawX + x * layout.scale,
  layout.drawY + y * layout.scale,
];

/** Fraction of the plan image (0..1, y down) at a canvas point. */
export const canvasToFraction = ([x, y]: ImagePoint, layout: CanvasLayout): ImagePoint => [
  (x - layout.drawX) / layout.drawWidth,
  (y - layout.drawY) / layout.drawHeight,
];

export const fractionToCanvas = ([fx, fy]: ImagePoint, layout: CanvasLayout): ImagePoint => [
  layout.drawX + fx * layout.drawWidth,
  layout.drawY + fy * layout.drawHeight,
];

/** A pin's target counts if it is on the plan (a little margin around it). */
export const onPlanFraction = (fraction: ImagePoint) => fraction.every((value) => value >= -0.05 && value <= 1.05);

/** Canvas unit under the mouse - the canvas (`rect` on screen) is shown at any width. */
export const clientToCanvas = (
  event: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number },
): ImagePoint | null =>
  rect.width && rect.height
    ? [((event.clientX - rect.left) * CANVAS_HEIGHT) / rect.height, ((event.clientY - rect.top) * CANVAS_HEIGHT) / rect.height]
    : null;

/** Zoom by `factor` around a canvas point (default: the middle) - the plan
 * point there stays where it is. */
export const zoomedView = (view: PlanView, factor: number, canvasWidth: number, at?: ImagePoint): PlanView => {
  const [pointerX, pointerY] = at ?? [canvasWidth / 2, CANVAS_HEIGHT / 2];
  const zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  const ratio = 1 - zoom / view.zoom;
  return {
    zoom,
    offsetX: view.offsetX + (pointerX - canvasWidth / 2 - view.offsetX) * ratio,
    offsetY: view.offsetY + (pointerY - CANVAS_HEIGHT / 2 - view.offsetY) * ratio,
  };
};

/** Canvas units of the plan that stay in the canvas at least (each axis) -
 * less if the plan is drawn smaller than 4 times that. */
const KEEP_IN_VIEW = 120;

/** The view moved so that some of the plan stays in the canvas - it can't
 * be panned or zoomed out of sight. */
export const keptInView = (view: PlanView, logical: { width: number; height: number }, image: PlanImage | null): PlanView => {
  if (!image) {
    return view;
  }
  const scale = alignmentBaseScale(image.naturalWidth, image.naturalHeight) * view.zoom;
  const limit = (canvasSize: number, drawSize: number) =>
    canvasSize / 2 + drawSize / 2 - Math.min(drawSize / 4, KEEP_IN_VIEW);
  const limitX = limit(logical.width, image.naturalWidth * scale);
  const limitY = limit(logical.height, image.naturalHeight * scale);
  const offsetX = clamp(view.offsetX, -limitX, limitX);
  const offsetY = clamp(view.offsetY, -limitY, limitY);
  return offsetX === view.offsetX && offsetY === view.offsetY ? view : { ...view, offsetX, offsetY };
};

/** The view showing an area of the image (image pixels, any two corners) as
 * large as it fits, `margin` canvas units around it - F. */
export const viewForImageArea = (
  [[x0, y0], [x1, y1]]: [ImagePoint, ImagePoint],
  logical: { width: number; height: number },
  image: PlanImage,
  margin = 24,
): PlanView => {
  const base = alignmentBaseScale(image.naturalWidth, image.naturalHeight);
  const width = Math.max(Math.abs(x1 - x0), 1);
  const height = Math.max(Math.abs(y1 - y0), 1);
  const zoom = clamp(
    Math.min((logical.width - 2 * margin) / (width * base), (logical.height - 2 * margin) / (height * base)),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  const scale = base * zoom;
  return {
    zoom,
    offsetX: scale * (image.naturalWidth / 2 - (x0 + x1) / 2),
    offsetY: scale * (image.naturalHeight / 2 - (y0 + y1) / 2),
  };
};

/** The image area (image pixels) around measure points / dm lines - at
 * least `minSize` of the plan's larger side, so one point is shown with the
 * plan around it - or null without any. */
export const itemsImageArea = (
  items: Iterable<MarkerItem>,
  transform: PointTransform,
  image: PlanImage,
  minSize = 0.08,
): [ImagePoint, ImagePoint] | null => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const item of items) {
    for (const point of item.end ? [item.start, item.end] : [item.start]) {
      const [cx, cy] = normalizedToCanvas(point, transform);
      xs.push((cx - transform.drawX) / transform.scale);
      ys.push((cy - transform.drawY) / transform.scale);
    }
  }
  if (!xs.length) {
    return null;
  }
  const pad = (low: number, high: number) => {
    const grow = Math.max(0, minSize * Math.max(image.naturalWidth, image.naturalHeight) - (high - low)) / 2;
    return [low - grow, high + grow];
  };
  const [left, right] = pad(Math.min(...xs), Math.max(...xs));
  const [top, bottom] = pad(Math.min(...ys), Math.max(...ys));
  return [
    [left, top],
    [right, bottom],
  ];
};

/** Zoom factor of a Ctrl + wheel step. */
export const wheelZoomFactor = (event: { deltaMode: number; deltaY: number }) => {
  const delta = clamp(event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY, -120, 120);
  return Math.exp(-delta * 0.0015);
};

/** A measure point as drawn: its place in sensor order (colour), label and
 * normalized start - plus the end of its band for a smartex dm sensor. */
export type MarkerItem = {
  point: Record<string, unknown>;
  label: string;
  color: string;
  start: ImagePoint;
  end: ImagePoint | null;
  /** Labelled even where the sensors are too close for labels ("Repair order"). */
  forceLabel?: boolean;
  labelColor?: string;
};

const finitePoint = (point: ImagePoint) => (point.every(Number.isFinite) ? point : null);

/** Measure points in sensor order, coloured along it (those without nx/ny left out). */
export const markerItems = (measurePoints: Array<Record<string, unknown>>): MarkerItem[] => {
  const valid = measurePoints
    .map((point, index) => ({
      point,
      order: finite(point.sensor_order ?? point.pos) || index + 1,
      start: [finite(point.nx), finite(point.ny)] as ImagePoint,
      end: finitePoint([finite(point.nx_end), finite(point.ny_end)]),
    }))
    .filter((entry) => entry.start.every(Number.isFinite))
    .sort((a, b) => a.order - b.order);
  return valid.map((entry, index) => ({
    point: entry.point,
    label: String(entry.order),
    color: rainbowColor(index, valid.length),
    start: entry.start,
    end: entry.end,
  }));
};

/** Measure points cut out (O), by id - normalized, as on the plan they came from. */
export type CutItem = { id: number; start: ImagePoint; end: ImagePoint | null };

export const cutItemsOf = (cutPoints: Array<Record<string, unknown>>): CutItem[] =>
  cutPoints
    .map((point) => ({
      id: Number(point.id),
      start: [finite(point.nx), finite(point.ny)] as ImagePoint,
      end: finitePoint([finite(point.nx_end), finite(point.ny_end)]),
    }))
    .filter((cut) => Number.isInteger(cut.id) && cut.start.every(Number.isFinite));

/** Cut points inserted at a normalized point: their middle (of the box around
 * them) goes there, their shape stays - null without any. */
export const cutPlacedAt = (cuts: CutItem[], at: ImagePoint | null): CutItem[] | null => {
  const corners = cuts.flatMap((cut) => (cut.end ? [cut.start, cut.end] : [cut.start]));
  if (!at || !corners.length) {
    return null;
  }
  const [atX, atY] = at;
  const middle = (axis: 0 | 1) =>
    (Math.min(...corners.map((corner) => corner[axis])) + Math.max(...corners.map((corner) => corner[axis]))) / 2;
  const [dx, dy] = [atX - middle(0), atY - middle(1)];
  const shift = ([x, y]: ImagePoint): ImagePoint => [x + dx, y + dy];
  return cuts.map((cut) => ({ id: cut.id, start: shift(cut.start), end: cut.end ? shift(cut.end) : null }));
};

/** The points of a group (ids) moved where the group alignment (L) puts them -
 * into the plan's frame and back. */
const groupMovedItems = (
  items: MarkerItem[],
  ids: Set<number>,
  transform: GroupTransform,
  alignment: AlignmentValues,
  image: PlanImage,
): MarkerItem[] => {
  const size = [image.naturalWidth, image.naturalHeight] as const;
  const base = alignmentBaseScale(...size);
  const move = (point: ImagePoint): ImagePoint =>
    toNormalized(applyGroup(toFraction(point, alignment, ...size, base), transform), alignment, ...size, base);
  return items.map((item) =>
    ids.has(Number(item.point.id)) ? { ...item, start: move(item.start), end: item.end ? move(item.end) : null } : item,
  );
};

/** What the canvas shows: the points - a group being aligned (its ids and
 * the fitted transform) where its pins put it, once the image is there. */
export const shownItemsOf = (
  items: MarkerItem[],
  group: { ids: Set<number> } | null,
  transform: GroupTransform | null,
  alignment: AlignmentValues,
  image: PlanImage | null,
) => (group && transform && image ? groupMovedItems(items, group.ids, transform, alignment, image) : items);

/** A normalized point as a fraction of the plan image (group pins). */
export const normalizedToFraction = (point: ImagePoint, alignment: AlignmentValues, image: PlanImage) => {
  const size = [image.naturalWidth, image.naturalHeight] as const;
  return toFraction(point, alignment, ...size, alignmentBaseScale(...size));
};

/** The box of a selection (two corners, image pixels). */
const boxOf = ([[ax, ay], [bx, by]]: [ImagePoint, ImagePoint]) => ({
  left: Math.min(ax, bx),
  top: Math.min(ay, by),
  right: Math.max(ax, bx),
  bottom: Math.max(ay, by),
});

/** The measure points a selection holds: a point inside the area, a dm band
 * with its start or end inside it. */
export const itemsInSelection = (
  items: MarkerItem[],
  selection: [ImagePoint, ImagePoint],
  alignment: AlignmentValues,
  image: PlanImage,
): Set<MarkerItem> => {
  const { left, top, right, bottom } = boxOf(selection);
  const inside = (point: ImagePoint) => {
    const [x, y] = normalizedToImage(point, alignment, image.naturalWidth, image.naturalHeight);
    return x >= left && x <= right && y >= top && y <= bottom;
  };
  return new Set(items.filter((item) => inside(item.start) || (item.end != null && inside(item.end))));
};

/** The measure points a point selection (D / O / L: `selecting`) holds - none
 * for an image edit or without an area / the image. */
export const selectedItemsOf = (
  selecting: boolean,
  items: MarkerItem[],
  selection: [ImagePoint, ImagePoint] | null,
  alignment: AlignmentValues,
  image: PlanImage | null,
) => (selecting && selection && image ? itemsInSelection(items, selection, alignment, image) : new Set<MarkerItem>());

/** The ids of measure points (those stored, with an integer id). */
export const pointIdsOf = (items: Iterable<MarkerItem>) =>
  [...items].map((item) => Number(item.point.id)).filter((id) => Number.isInteger(id));

/** The selected area in image pixels, once it can be applied (MIN_SELECTION). */
export const selectionRect = (selection: [ImagePoint, ImagePoint] | null) => {
  if (!selection) {
    return null;
  }
  const { left, top, right, bottom } = boxOf(selection);
  const rect = { x: left, y: top, width: right - left, height: bottom - top };
  return rect.width >= MIN_SELECTION && rect.height >= MIN_SELECTION ? rect : null;
};

/** Index of the measure point / dm line closest to a canvas point within
 * `tolerance` canvas units - or null. */
export const nearestItem = (
  items: MarkerItem[],
  at: ImagePoint,
  transform: PointTransform,
  tolerance: number,
): number | null => {
  let best: number | null = null;
  let bestDistance = tolerance;
  for (const [index, item] of items.entries()) {
    const start = normalizedToCanvas(item.start, transform);
    const distance = item.end
      ? segmentDistance(at, start, normalizedToCanvas(item.end, transform))
      : Math.hypot(start[0] - at[0], start[1] - at[1]);
    if (distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
};

/** The point grabbed on a sensor at a canvas point - normalized as stored
 * (`item`), though grabbed where it is shown (`shown`); on a dm line where
 * along it it was grabbed. */
export const grabbedPoint = (
  item: MarkerItem,
  shown: MarkerItem,
  at: ImagePoint,
  transform: PointTransform,
): ImagePoint => {
  if (!item.end || !shown.end) {
    return item.start;
  }
  const t = segmentPosition(at, normalizedToCanvas(shown.start, transform), normalizedToCanvas(shown.end, transform));
  return [item.start[0] + t * (item.end[0] - item.start[0]), item.start[1] + t * (item.end[1] - item.start[1])];
};

/** The placed sensor (topmost) at a canvas point within `radius` canvas units. */
export const sensorAtPoint = <T extends { nx: number; ny: number }>(
  sensors: T[],
  at: ImagePoint,
  transform: PointTransform,
  radius: number,
): T | null =>
  [...sensors].reverse().find((sensor) => {
    const [x, y] = normalizedToCanvas([sensor.nx, sensor.ny], transform);
    return Math.hypot(x - at[0], y - at[1]) <= radius;
  }) ?? null;

/** Distance of two picked calibration points (image pixels), null before both are picked. */
export const calibrationDistance = (points: ImagePoint[]) =>
  points.length === 2 ? Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]) : null;

/** A positive number typed in a field (comma or point), else null. */
export const positiveNumber = (text: string) => {
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** Length of a dm band (normalized ends) in meters, as the plan shows it. */
export const bandMeters = (
  item: { start: ImagePoint; end: ImagePoint },
  image: PlanImage,
  alignment: { scaleX: number; scaleY: number },
  metersPerPixel: number,
) =>
  Math.hypot(
    (item.end[0] - item.start[0]) * image.naturalWidth * alignment.scaleX,
    (item.end[1] - item.start[1]) * image.naturalHeight * alignment.scaleY,
  ) * metersPerPixel;
