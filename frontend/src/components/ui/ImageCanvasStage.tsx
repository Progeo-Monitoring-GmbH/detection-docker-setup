import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwise, ArrowCounterclockwise, Magic } from 'react-bootstrap-icons';
import axiosConfig from '../../axiosConfig';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import { childTestId } from '../../testIds';
import ZoomControls from '../device/ZoomControls';
import { ALIGN_PINS, fitAlignment, type AlignPin } from './alignmentFit';
import CanvasKeyLegend from './CanvasKeyLegend';
import { applyGroup, fitGroup, toFraction, toNormalized, type GroupPin } from './groupAlign';
import { isZoomWheel, useWheelHint, WheelZoomHint } from './wheelZoom';
import './ImageCanvasStage.css';

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

// The canvas' own coordinate system (positions, pan, stored offsets); it is
// drawn at the size it is shown, sharp at any width (see pixelRatio).
const CANVAS_WIDTH = 900;
const CANVAS_HEIGHT = 600;
const CANVAS_PADDING = 32;
const LOGICAL = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
// Backing store pixels per canvas unit at most (huge screens / zoomed pages).
const MAX_PIXEL_RATIO = 4;
// Screen pixels: how close the mouse must be to a sensor for its tooltip,
// and the average distance between sensors from which they get labels.
const HOVER_TOLERANCE = 8;
const LABEL_SPACING = 34;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 20;
/** Zoom per click of the zoom buttons. */
const ZOOM_STEP = 1.5;

/** Colour of the index-th of `count` sensors in sensor order, red to violet:
 * neighbours are told apart, and runs of sensors are easy to follow. */
const rainbowColor = (index: number, count: number) =>
  `hsl(${count > 1 ? Math.round((index / (count - 1)) * 280) : 0}, 85%, 45%)`;

const RAINBOW_GRADIENT = `linear-gradient(to right, ${[0, 1, 2, 3, 4]
  .map((step) => rainbowColor(step, 5))
  .join(', ')})`;

const segmentDistance = (
  [px, py]: [number, number],
  [ax, ay]: [number, number],
  [bx, by]: [number, number],
) => {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? clamp(((px - ax) * dx + (py - ay) * dy) / lengthSq, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

const finite = (value: unknown) => (value == null || value === '' ? NaN : Number(value));

/** Image pixel of a normalized point (nx/ny) under the point alignment -
 * where the canvas draws it, independent of zoom and pan. */
export const normalizedToImage = (
  [nx, ny]: [number, number],
  alignment: { offsetX: number; offsetY: number; scaleX: number; scaleY: number; flipY: boolean },
  width: number,
  height: number,
): [number, number] => {
  const base = alignmentBaseScale(width, height);
  return [
    alignment.offsetX / base + nx * width * alignment.scaleX,
    alignment.offsetY / base + (alignment.flipY ? 1 - ny : ny) * height * alignment.scaleY,
  ];
};

/**
 * Scale at which the alignment canvas fits a Lageplan of the given size (at
 * zoom 1). A Lageplan's stored offset_x/offset_y are canvas pixels at this
 * scale, so offset_x / (width * alignmentBaseScale(...)) is the offset as a
 * fraction of the image - SensorHeatmap2D uses this to place points the
 * same way.
 */
export const alignmentBaseScale = (imageWidth: number, imageHeight: number) =>
  Math.min(
    (CANVAS_WIDTH - CANVAS_PADDING) / imageWidth,
    (CANVAS_HEIGHT - CANVAS_PADDING) / imageHeight,
    1.5,
  );

/** Where the plan is drawn on the canvas (canvas pixels) and at which scale
 * (canvas pixels per image pixel). */
const canvasLayout = (
  canvas: { width: number; height: number },
  image: HTMLImageElement,
  zoom: number,
  panX: number,
  panY: number,
) => {
  const scale =
    alignmentBaseScale(image.naturalWidth, image.naturalHeight) * zoom;
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  return {
    scale,
    drawWidth,
    drawHeight,
    drawX: canvas.width / 2 - drawWidth / 2 + panX,
    drawY: canvas.height / 2 - drawHeight / 2 + panY,
  };
};

type ImagePoint = [number, number];

/** How measure points (normalized nx/ny) sit on the canvas: the plan's
 * layout plus the point alignment (offset/scale/flip of the sliders). */
type PointTransform = ReturnType<typeof canvasLayout> & {
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  flipY: boolean;
  zoom: number;
};

const normalizedToCanvas = (
  [nx, ny]: ImagePoint,
  t: PointTransform,
): ImagePoint => [
  t.drawX + t.offsetX * t.zoom + nx * t.drawWidth * t.scaleX,
  t.drawY +
    t.offsetY * t.zoom +
    (t.flipY ? 1 - ny : ny) * t.drawHeight * t.scaleY,
];

const canvasToNormalized = (
  [x, y]: ImagePoint,
  t: PointTransform,
): ImagePoint => {
  const drawnY = (y - t.drawY - t.offsetY * t.zoom) / (t.drawHeight * t.scaleY);
  return [
    (x - t.drawX - t.offsetX * t.zoom) / (t.drawWidth * t.scaleX),
    t.flipY ? 1 - drawnY : drawnY,
  ];
};

type CutItem = { id: number; start: ImagePoint; end: ImagePoint | null };

/** Cut points inserted at a normalized point: their middle (of the box around
 * them) goes there, their shape stays - null without any. */
const cutPlacedAt = (cuts: CutItem[], [atX, atY]: ImagePoint): CutItem[] | null => {
  const corners = cuts.flatMap((cut) => (cut.end ? [cut.start, cut.end] : [cut.start]));
  if (!corners.length) {
    return null;
  }
  const middle = (axis: 0 | 1) =>
    (Math.min(...corners.map((corner) => corner[axis])) + Math.max(...corners.map((corner) => corner[axis]))) / 2;
  const [dx, dy] = [atX - middle(0), atY - middle(1)];
  const shift = ([x, y]: ImagePoint): ImagePoint => [x + dx, y + dy];
  return cuts.map((cut) => ({ id: cut.id, start: shift(cut.start), end: cut.end ? shift(cut.end) : null }));
};

/** A sensor placed by hand (Lageplan wizard), normalized like nx/ny. */
export type PlacedSensor = {
  deviceId: number;
  label: string;
  nx: number;
  ny: number;
};

/** Placing sensors by hand: a click on the plan places the active device,
 * placed sensors can be dragged. Shown instead of `measurePoints`. */
type SensorPlacement = {
  sensors: PlacedSensor[];
  activeDeviceId: number | null;
  activeLabel?: string;
  onPlace: (nx: number, ny: number) => void;
  onMove: (deviceId: number, nx: number, ny: number) => void;
  onSelect: (deviceId: number) => void;
};

/** A measure point as drawn: its place in sensor order (colour), label and
 * normalized start - plus the end of its band for a smartex dm sensor. */
type MarkerItem = {
  point: Record<string, unknown>;
  label: string;
  color: string;
  start: ImagePoint;
  end: ImagePoint | null;
};

const SENSOR_RADIUS = 9;

/** Mouse travel (px) up to which a press on the plan still counts as a click. */
const CLICK_TOLERANCE = 4;

/** Delay (ms) after the last change of the alignment before it is stored. */
const ALIGN_STORE_DELAY = 600;

/** Click tools: pan (default), place the metric reference point, or pick
 * the two points of a known distance for the meters-per-pixel calibration
 * (picked only while M is held - plain presses still pan). */
type CanvasTool = 'pan' | 'reference' | 'calibrate';
/** Held keys that change what a press on the plan does: A drags sensors to
 * align, R sets the reference point, M picks a calibration point; D / O / L
 * + drag select measure points to remove / cut out / align as a group, and
 * I + click inserts the cut ones. */
type HeldKey = 'a' | 'r' | 'm' | 'd' | 'o' | 'l' | 'i';
const HELD_KEYS: HeldKey[] = ['a', 'r', 'm', 'd', 'o', 'l', 'i'];
/** Edits of the plan image, switched on by a key press: C fills the selected
 * area white, X crops the plan to it - each only once "Apply" is pressed. */
type ImageEdit = 'clear' | 'crop';
const EDIT_KEYS: Record<string, ImageEdit> = { c: 'clear', x: 'crop' };
/** What measure points selected with a held key + drag are for. */
type PointSelect = 'remove' | 'cut' | 'group';
const SELECT_KEYS: Partial<Record<HeldKey, PointSelect>> = { d: 'remove', o: 'cut', l: 'group' };
/** What a selected area is for: an image edit, or the measure points in it. */
type SelectMode = ImageEdit | PointSelect;
/** Colours of the point actions: remove, cut out / insert, group alignment. */
const REMOVE_COLOR = '#C44D26';
const CUT_COLOR = '#B7791F';
const GROUP_COLOR = '#6f42c1';
/** Image pixels a selection needs at least (both sides) to be applied. */
const MIN_SELECTION = 2;

const requestReason = (requestError: unknown) =>
  (requestError as { response?: { data?: { reason?: string } } })?.response?.data?.reason ??
  (requestError as Error).message;

type AlignmentValues = {
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  flipY: boolean;
};
const sameAlignment = (a: AlignmentValues, b: AlignmentValues) =>
  a.offsetX === b.offsetX &&
  a.offsetY === b.offsetY &&
  a.scaleX === b.scaleX &&
  a.scaleY === b.scaleY &&
  a.flipY === b.flipY;

export type PlanScaleValues = {
  reference_x?: number;
  reference_y?: number;
  meters_per_pixel?: number;
};

type ImageCanvasStageProps = {
  imageUrl?: string;
  locationId?: number;
  /** The Lageplan shown - the flip toggle stores onto it (else the active one). */
  lageplanId?: number;
  sourceMeta?: {
    offset_x?: number;
    offset_y?: number;
    scale_x?: number;
    scale_y?: number;
    flip_x?: boolean;
    flip_y?: boolean;
    reference_x?: number | null;
    reference_y?: number | null;
    meters_per_pixel?: number | null;
  };
  title?: string;
  fileName?: string;
  measurePoints?: Array<Record<string, unknown>>;
  /** smartex dm: the sensors are band lines from nx/ny to nx_end/ny_end. */
  lineSensors?: boolean;
  /** Names of the devices points are connected to (tooltip), by id. */
  deviceLabels?: Record<number, string>;
  /** sensor_order of each device's pair 1 (ProgeoDevice.first_sensor_order), by id. */
  devicePairStarts?: Record<number, number>;
  withSliders?: boolean;
  /** Stores the alignment - called by itself shortly after it changed. */
  onSaveSliders?: (values: AlignmentValues) => void;
  /** Stores the metric scale (reference point in image pixels, m/px). */
  onSaveScale?: (values: PlanScaleValues) => void;
  placement?: SensorPlacement;
  /** Enables clearing (C) and cropping (X) the plan image, done on the server
   * (measure_points/edit_lageplan) - called with its answer, which carries
   * the stored plan ("lageplan": new url, a crop's moved alignment). */
  onImageEdited?: (response: Record<string, unknown>) => void;
  /** Enables removing measure points (hold D, drag over them, "Remove"),
   * done on the server (measure_points/remove) - called with its answer,
   * which lists the removed ids ("point_ids"). */
  onPointsRemoved?: (response: Record<string, unknown>) => void;
  /** Measure points cut out (O + drag) - kept by the caller, on any plan, until
   * inserted (I + click) or discarded. */
  cutPoints?: Array<Record<string, unknown>>;
  /** Enables cutting out (O + drag, "Cut"): the selected points' records - the
   * caller keeps them and leaves them out of measurePoints. Nothing is stored. */
  onCut?: (points: Array<Record<string, unknown>>) => void;
  onDiscardCut?: () => void;
  /** Enables inserting the cut points (I + click) and aligning a group of
   * points (L + drag), stored on the server (measure_points/place) - called
   * with its answer, which carries the moved points ("points"). */
  onPointsPlaced?: (response: Record<string, unknown>, action: 'insert' | 'align') => void;
  /** data-testid of the stage; its parts are "<testId>-canvas", "-zoom", "-apply", "-scale-store", ... */
  testId?: string;
};

const ImageCanvasStage = ({
  imageUrl,
  sourceMeta,
  title = 'Image preview',
  fileName,
  measurePoints = [],
  lineSensors = false,
  deviceLabels,
  devicePairStarts,
  withSliders = false,
  locationId,
  lageplanId,
  onSaveSliders,
  onSaveScale,
  placement,
  onImageEdited,
  onPointsRemoved,
  cutPoints = [],
  onCut,
  onDiscardCut,
  onPointsPlaced,
  testId = 'image-canvas',
}: ImageCanvasStageProps) => {
  const auth = useAuth();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startOffsetX: number;
    startOffsetY: number;
  } | null>(null);
  // Placement: the sensor being dragged, and where a press on the plan
  // started (a click places, a drag pans).
  const sensorDragRef = useRef<number | null>(null);
  const pressRef = useRef<{ x: number; y: number } | null>(null);

  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageError, setImageError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [pointOffsetX, setPointOffsetX] = useState(sourceMeta?.offset_x ?? 0);
  const [pointOffsetY, setPointOffsetY] = useState(sourceMeta?.offset_y ?? 0);
  const [pointScaleX, setPointScaleX] = useState(sourceMeta?.scale_x ?? 1);
  const [pointScaleY, setPointScaleY] = useState(sourceMeta?.scale_y ?? 1);
  const [isVerticallyFlipped, setIsVerticallyFlipped] = useState(
    // Flipped unless the plan says otherwise - the wizard's default.
    sourceMeta?.flip_y ?? true,
  );
  const [tool, setTool] = useState<CanvasTool>('pan');
  // Taken from sourceMeta once: a different plan mounts anew (key), and a
  // stored scale or alignment must not reset what else is being edited.
  const [referencePoint, setReferencePoint] = useState<ImagePoint | null>(() =>
    sourceMeta?.reference_x != null && sourceMeta.reference_y != null
      ? [sourceMeta.reference_x, sourceMeta.reference_y]
      : null,
  );
  const [calibrationPoints, setCalibrationPoints] = useState<ImagePoint[]>([]);
  const [calibrationMeters, setCalibrationMeters] = useState('');
  const [metersPerPixel, setMetersPerPixel] = useState(() =>
    sourceMeta?.meters_per_pixel ? String(sourceMeta.meters_per_pixel) : '',
  );
  // The sensor under the mouse (index into items) and the mouse position
  // over the canvas in CSS pixels, for its tooltip.
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  // Point calibration: while A is held (alignKey), a sensor dragged onto its
  // place on the plan is pinned there - from the pins (by index into items)
  // the alignment is computed (alignmentFit); the values before are restored
  // on cancel. alignDrag: the sensor being dragged, the grabbed point on it
  // (normalized) and the mouse (canvas units).
  const [heldKey, setHeldKey] = useState<HeldKey | null>(null);
  const alignKey = heldKey === 'a';
  const [pins, setPins] = useState<Array<AlignPin & { index: number }>>([]);
  const [alignDrag, setAlignDrag] = useState<{ index: number; source: ImagePoint; at: ImagePoint } | null>(null);
  const aligning = pins.length > 0 || alignDrag != null;
  const [alignBefore, setAlignBefore] = useState<AlignmentValues | null>(null);
  // Auto alignment (measure_points/auto_align): the request, the share of
  // sensor points it laid onto the plan's orange lines and the values
  // before - for Undo.
  const [autoAlign, setAutoAlign] = useState<
    | { busy: true }
    | { busy: false; score: number; matched: boolean; before: AlignmentValues }
    | { busy: false; error: string }
    | null
  >(null);
  // Image edit (C / X) or removing points (D): the mode, the selected area
  // (two corners in image pixels), whether it is being dragged, and the
  // request applying it.
  const [editMode, setEditMode] = useState<SelectMode | null>(null);
  const editModeRef = useRef(editMode);
  editModeRef.current = editMode;
  const [selection, setSelection] = useState<[ImagePoint, ImagePoint] | null>(null);
  const [selecting, setSelecting] = useState(false);
  // Set at once on the press: the mouse may move before the next render.
  const selectingRef = useRef(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');
  // Group alignment (L): the points (ids), their pins (where a grabbed point
  // is now -> where it belongs, fractions of the image) and the one being
  // dragged (the grabbed point now, the mouse in canvas units).
  const [group, setGroup] = useState<{ ids: Set<number>; pins: Array<GroupPin & { id: number }> } | null>(null);
  const [groupDrag, setGroupDrag] = useState<{ id: number; source: ImagePoint; at: ImagePoint } | null>(null);
  // Insert (I held): the normalized point under the mouse - the cut points' middle goes there.
  const [insertAt, setInsertAt] = useState<ImagePoint | null>(null);

  // Shown width of the canvas (CSS pixels): it is drawn at that size times
  // the device pixel ratio; sizes of markers and labels are screen pixels.
  const [cssWidth, setCssWidth] = useState(CANVAS_WIDTH);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) {
        setCssWidth(entry.contentRect.width);
      }
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);
  const screenScale = cssWidth / CANVAS_WIDTH;
  const pixelRatio = Math.min(
    MAX_PIXEL_RATIO,
    screenScale * (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1),
  );
  // Canvas units per screen pixel.
  const px = 1 / screenScale;
  const screenScaleRef = useRef(screenScale);
  screenScaleRef.current = screenScale;

  // Measure points in sensor order, coloured along it.
  const items = useMemo<MarkerItem[]>(() => {
    const valid = measurePoints
      .map((point, index) => {
        const start: ImagePoint = [finite(point.nx), finite(point.ny)];
        const end: ImagePoint = [finite(point.nx_end), finite(point.ny_end)];
        return {
          point,
          order: finite(point.sensor_order ?? point.pos) || index + 1,
          start,
          end: end.every(Number.isFinite) ? end : null,
        };
      })
      .filter((entry) => entry.start.every(Number.isFinite))
      .sort((a, b) => a.order - b.order);
    return valid.map((entry, index) => ({
      point: entry.point,
      label: String(entry.order),
      color: rainbowColor(index, valid.length),
      start: entry.start,
      end: entry.end,
    }));
  }, [measurePoints]);
  const lineCount = items.filter((item) => item.end).length;
  const lineMode = lineSensors || lineCount > 0;

  // Point calibration with the sliders' panel (alignment editable), not while placing sensors.
  const canAlign = withSliders && !placement && image != null && items.length >= ALIGN_PINS;
  // Auto alignment of a stored plan's points onto its orange lines.
  const canAutoAlign =
    withSliders && !placement && image != null && items.length > 0 && locationId != null && lageplanId != null;
  // Reference point and calibration with the scale panel.
  const canScale = withSliders && onSaveScale != null && image != null;
  // Clearing / cropping the image of a stored plan, not during the point calibration.
  const canEditImage =
    withSliders && onImageEdited != null && image != null && locationId != null && lageplanId != null;
  const canEditImageRef = useRef(false);
  canEditImageRef.current = canEditImage && !aligning;
  // Editing stored measure points (D / O / L / I) - not while placing by hand.
  const pointsEditable = withSliders && !placement && image != null && locationId != null;
  const canRemovePoints = pointsEditable && onPointsRemoved != null && items.length > 0;
  const canCut = pointsEditable && onCut != null && items.length > 0;
  const canPlace = pointsEditable && onPointsPlaced != null && lageplanId != null;
  const canGroup = canPlace && items.length > 0;
  const canSelectFor = (mode: SelectMode) =>
    mode === 'remove' ? canRemovePoints : mode === 'cut' ? canCut : mode === 'group' ? canGroup : canEditImage;

  // The plan's point alignment, and how a normalized point moves with the
  // group alignment (L) - into the plan's frame and back.
  const planAlignment = useMemo<AlignmentValues>(
    () => ({
      offsetX: pointOffsetX,
      offsetY: pointOffsetY,
      scaleX: pointScaleX,
      scaleY: pointScaleY,
      flipY: isVerticallyFlipped,
    }),
    [pointOffsetX, pointOffsetY, pointScaleX, pointScaleY, isVerticallyFlipped],
  );
  const groupFit = group ? fitGroup(group.pins) : null;
  const groupTransform = groupFit && 'transform' in groupFit ? groupFit.transform : null;
  // What the canvas shows: the points - a group being aligned where its pins put it.
  const shownItems = useMemo<MarkerItem[]>(() => {
    if (!group || !groupTransform || !image) {
      return items;
    }
    const size = [image.naturalWidth, image.naturalHeight] as const;
    const base = alignmentBaseScale(...size);
    const move = (point: ImagePoint): ImagePoint =>
      toNormalized(applyGroup(toFraction(point, planAlignment, ...size, base), groupTransform), planAlignment, ...size, base);
    return items.map((item) =>
      group.ids.has(Number(item.point.id))
        ? { ...item, start: move(item.start), end: item.end ? move(item.end) : null }
        : item,
    );
  }, [items, group, groupTransform, image, planAlignment]);

  // The measure points a held key + drag has selected (D / O / L): a point
  // inside the area, a dm band with its start or end inside it.
  const pointSelect = editMode === 'remove' || editMode === 'cut' || editMode === 'group' ? editMode : null;
  const selectedItems = useMemo(() => {
    if (!pointSelect || !selection || !image) {
      return new Set<MarkerItem>();
    }
    const [[ax, ay], [bx, by]] = selection;
    const [left, top, right, bottom] = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
    const inside = (point: ImagePoint) => {
      const [x, y] = normalizedToImage(point, planAlignment, image.naturalWidth, image.naturalHeight);
      return x >= left && x <= right && y >= top && y <= bottom;
    };
    return new Set(shownItems.filter((item) => inside(item.start) || (item.end != null && inside(item.end))));
  }, [pointSelect, selection, image, shownItems, planAlignment]);
  const selectedIds = [...selectedItems]
    .map((item) => Number(item.point.id))
    .filter((id) => Number.isInteger(id));

  // The cut points (O), and where I + click would insert them: their middle
  // at the mouse, the shape kept (normalized, as on the plan they came from).
  const cutItems = useMemo<CutItem[]>(
    () =>
      cutPoints
        .map((point) => ({
          id: Number(point.id),
          start: [finite(point.nx), finite(point.ny)] as ImagePoint,
          end: [finite(point.nx_end), finite(point.ny_end)] as ImagePoint,
        }))
        .filter((cut) => Number.isInteger(cut.id) && cut.start.every(Number.isFinite))
        .map((cut) => ({ ...cut, end: cut.end.every(Number.isFinite) ? cut.end : null })),
    [cutPoints],
  );
  const canInsert = canPlace && cutItems.length > 0;
  const insertPlan = useMemo(() => (insertAt ? cutPlacedAt(cutItems, insertAt) : null), [insertAt, cutItems]);

  const insertGhost = heldKey === 'i' && canInsert ? insertPlan : null;
  // The colour of a selection (outline, marks): clear and remove red.
  const selectColor = editMode === 'cut' ? CUT_COLOR : editMode === 'group' ? GROUP_COLOR : REMOVE_COLOR;

  const leaveGroup = () => {
    setGroup(null);
    setGroupDrag(null);
  };
  const leaveEdit = () => {
    setEditMode(null);
    setSelection(null);
    selectingRef.current = false;
    setSelecting(false);
    setEditError('');
  };
  // A/R/M (no modifier, not typing) held: what a press on the plan does;
  // released on keyup or leaving the window. C/X switch the image edit on
  // and off, Escape leaves it.
  useEffect(() => {
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'escape') {
        leaveEdit();
        leaveGroup();
        return;
      }
      const edit = EDIT_KEYS[key];
      if (edit) {
        if (!event.repeat && canEditImageRef.current) {
          // The other key switches the mode and keeps the selection.
          const next = editModeRef.current === edit ? null : edit;
          setEditMode(next);
          setEditError('');
          if (!next) {
            setSelection(null);
          }
        }
        return;
      }
      if (HELD_KEYS.includes(key as HeldKey)) {
        setHeldKey(key as HeldKey);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      setHeldKey((current) => (current === key ? null : current));
    };
    const release = () => setHeldKey(null);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
    };
  }, []);

  // The alignment of the pins, applied to the sliders as soon as it can be computed.
  const alignFit = useMemo(
    () =>
      aligning && image
        ? fitAlignment(
            pins,
            image.naturalWidth,
            image.naturalHeight,
            alignmentBaseScale(image.naturalWidth, image.naturalHeight),
          )
        : null,
    [aligning, image, pins],
  );
  useEffect(() => {
    if (alignFit && 'alignment' in alignFit) {
      const { alignment } = alignFit;
      setPointOffsetX(alignment.offsetX);
      setPointOffsetY(alignment.offsetY);
      setPointScaleX(alignment.scaleX);
      setPointScaleY(alignment.scaleY);
      setIsVerticallyFlipped(alignment.flipY);
    }
  }, [alignFit]);

  useEffect(() => {
    setImage(null);
    setImageError('');
    if (!imageUrl) {
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    const loadImage = (src: string) => {
      const nextImage = new Image();
      nextImage.onload = () => {
        if (!cancelled) {
          setImage(nextImage);
        }
      };
      nextImage.onerror = () => {
        if (!cancelled) {
          setImageError('The Lageplan image could not be displayed.');
        }
      };
      nextImage.src = src;
    };

    // Local previews (blob:/data:) load directly; backend media requires the
    // Authorization header, which a plain <img> request can't send.
    if (/^(blob|data):/i.test(imageUrl)) {
      loadImage(imageUrl);
    } else {
      void axiosConfig.perform_get(
        auth,
        imageUrl,
        (response) => {
          if (cancelled) {
            return;
          }
          objectUrl = URL.createObjectURL(response.data as Blob);
          loadImage(objectUrl);
        },
        (loadError) => {
          if (!cancelled) {
            setImageError(
              `Could not load the Lageplan image: ${(loadError as Error).message}`,
            );
          }
        },
        { responseType: 'blob' },
      );
    }

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [auth, imageUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    // Drawn in canvas units (LOGICAL), at pixelRatio backing pixels each.
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    const { width, height } = LOGICAL;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#f5f6f8';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';

    const layout = canvasLayout(LOGICAL, image, zoom, offsetX, offsetY);
    const { scale, drawWidth, drawHeight, drawX, drawY } = layout;
    const transform: PointTransform = {
      ...layout,
      offsetX: pointOffsetX,
      offsetY: pointOffsetY,
      scaleX: pointScaleX,
      scaleY: pointScaleY,
      flipY: isVerticallyFlipped,
      zoom,
    };
    const toCanvas = ([x, y]: ImagePoint): ImagePoint => [
      drawX + x * scale,
      drawY + y * scale,
    ];

    ctx.strokeStyle = '#cfd4da';
    ctx.lineWidth = px;
    ctx.strokeRect(px / 2, px / 2, width - px, height - px);
    ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);

    // Image edit: the selected area - white as "clear" will leave it, or the
    // rest of the plan dimmed for "crop". The points stay on top.
    if (editMode && selection) {
      const [[ax, ay], [bx, by]] = selection.map(toCanvas);
      const [left, top, right, bottom] = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
      if (editMode === 'crop') {
        ctx.beginPath();
        ctx.rect(drawX, drawY, drawWidth, drawHeight);
        ctx.rect(left, top, right - left, bottom - top);
        ctx.fillStyle = 'rgba(16, 20, 25, 0.45)';
        ctx.fill('evenodd');
      } else if (pointSelect) {
        ctx.save();
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = selectColor;
        ctx.fillRect(left, top, right - left, bottom - top);
        ctx.restore();
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(left, top, right - left, bottom - top);
      }
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.lineWidth = 1.5 * px;
      ctx.strokeStyle = editMode === 'crop' ? '#0d6efd' : selectColor;
      ctx.strokeRect(left, top, right - left, bottom - top);
      ctx.setLineDash([]);
    }

    /** Text with a white halo, readable on any plan. */
    const drawLabel = (text: string, x: number, y: number, color: string, size = 11) => {
      ctx.font = `600 ${size * px}px sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3.5 * px;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    };
    // Pins (A, L): a fraction of the image on the canvas, the dashed line from
    // a point to where it is dragged / pinned, and a pin's numbered crosshair.
    const fractionToCanvas = ([fx, fy]: ImagePoint): ImagePoint => [drawX + fx * drawWidth, drawY + fy * drawHeight];
    const pinLine = (from: ImagePoint, to: ImagePoint, color: string) => {
      ctx.beginPath();
      ctx.moveTo(from[0], from[1]);
      ctx.lineTo(to[0], to[1]);
      ctx.setLineDash([5 * px, 4 * px]);
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const pinMark = ([tx, ty]: ImagePoint, number: number, color: string) => {
      ctx.beginPath();
      ctx.moveTo(tx - 10 * px, ty);
      ctx.lineTo(tx + 10 * px, ty);
      ctx.moveTo(tx, ty - 10 * px);
      ctx.lineTo(tx, ty + 10 * px);
      ctx.lineWidth = 2.5 * px;
      ctx.strokeStyle = color;
      ctx.stroke();
      drawLabel(String(number + 1), tx + 8 * px, ty - 10 * px, color, 13);
    };

    // Sensors placed by hand: numbered dots with their label (MAC) beside.
    placement?.sensors.forEach((sensor, index) => {
      const [pointX, pointY] = normalizedToCanvas(
        [sensor.nx, sensor.ny],
        transform,
      );
      const active = sensor.deviceId === placement.activeDeviceId;

      ctx.beginPath();
      ctx.arc(pointX, pointY, SENSOR_RADIUS * px, 0, Math.PI * 2);
      ctx.fillStyle = active ? '#0d6efd' : '#198754';
      ctx.fill();
      ctx.lineWidth = (active ? 3 : 2) * px;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      ctx.font = `600 ${11 * px}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(index + 1), pointX, pointY);

      drawLabel(sensor.label, pointX + (SENSOR_RADIUS + 4) * px, pointY, active ? '#0d6efd' : '#212529', 12);
    });

    // Measure points, rainbow-coloured in sensor order; a smartex dm sensor
    // is its band line from the point (start) to its end. The hovered one is
    // drawn last, on top. Sizes are screen pixels (px) at any zoom.
    const hovered = hover ? (shownItems[hover.index] ?? null) : null;
    const shown = placement ? [] : shownItems;
    const positioned = shown.map((item) => ({
      item,
      start: normalizedToCanvas(item.start, transform),
      end: item.end ? normalizedToCanvas(item.end, transform) : null,
    }));
    const drawOrder = hovered
      ? [...positioned.filter((entry) => entry.item !== hovered), ...positioned.filter((entry) => entry.item === hovered)]
      : positioned;

    drawOrder.forEach(({ item, start, end }) => {
      const active = item === hovered;
      if (end) {
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(start[0], start[1]);
        ctx.lineTo(end[0], end[1]);
        ctx.lineWidth = (active ? 9 : 5.5) * px;
        ctx.strokeStyle = active ? '#101419' : 'rgba(255, 255, 255, 0.85)';
        ctx.stroke();
        ctx.lineWidth = (active ? 5.5 : 3) * px;
        ctx.strokeStyle = item.color;
        ctx.stroke();
        return;
      }
      ctx.beginPath();
      ctx.arc(start[0], start[1], (active ? 8.5 : 6.5) * px, 0, Math.PI * 2);
      ctx.fillStyle = item.color;
      ctx.fill();
      ctx.lineWidth = (active ? 3 : 2) * px;
      ctx.strokeStyle = active ? '#101419' : '#ffffff';
      // A dm sensor without its band: dashed.
      ctx.setLineDash(lineMode ? [3 * px, 2 * px] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // D + drag: the points to remove, crossed out in red; O / L + drag: the
    // points to cut out / align, ringed.
    positioned
      .filter(({ item }) => selectedItems.has(item))
      .forEach(({ start, end }) => {
        if (end) {
          ctx.beginPath();
          ctx.moveTo(start[0], start[1]);
          ctx.lineTo(end[0], end[1]);
          ctx.setLineDash([4 * px, 3 * px]);
          ctx.lineWidth = 2 * px;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.strokeStyle = selectColor;
        ctx.lineWidth = 2.5 * px;
        [start, ...(end ? [end] : [])].forEach(([x, y]) => {
          const arm = 6 * px;
          ctx.beginPath();
          if (pointSelect === 'remove') {
            ctx.moveTo(x - arm, y - arm);
            ctx.lineTo(x + arm, y + arm);
            ctx.moveTo(x + arm, y - arm);
            ctx.lineTo(x - arm, y + arm);
          } else {
            ctx.arc(x, y, 10 * px, 0, Math.PI * 2);
          }
          ctx.stroke();
        });
      });

    // Group alignment (L): its points haloed, each pin's target a crosshair,
    // the point being dragged follows the mouse.
    if (group) {
      ctx.strokeStyle = GROUP_COLOR;
      ctx.lineWidth = 2 * px;
      positioned
        .filter(({ item }) => group.ids.has(Number(item.point.id)))
        .forEach(({ start, end }) => {
          [start, ...(end ? [end] : [])].forEach(([x, y]) => {
            ctx.beginPath();
            ctx.arc(x, y, 9 * px, 0, Math.PI * 2);
            ctx.stroke();
          });
        });
      group.pins.forEach((pin, number) => pinMark(fractionToCanvas(pin.target), number, GROUP_COLOR));
      if (groupDrag) {
        pinLine(fractionToCanvas(groupDrag.source), groupDrag.at, GROUP_COLOR);
        ctx.beginPath();
        ctx.arc(groupDrag.at[0], groupDrag.at[1], 7 * px, 0, Math.PI * 2);
        ctx.fillStyle = GROUP_COLOR;
        ctx.fill();
      }
    }

    // I held: the cut points where a click inserts them, dashed.
    if (insertGhost) {
      ctx.strokeStyle = CUT_COLOR;
      ctx.fillStyle = 'rgba(183, 121, 31, 0.25)';
      ctx.lineWidth = 2 * px;
      ctx.setLineDash([4 * px, 3 * px]);
      insertGhost.forEach((ghost) => {
        const start = normalizedToCanvas(ghost.start, transform);
        ctx.beginPath();
        if (ghost.end) {
          const end = normalizedToCanvas(ghost.end, transform);
          ctx.moveTo(start[0], start[1]);
          ctx.lineTo(end[0], end[1]);
          ctx.stroke();
        } else {
          ctx.arc(start[0], start[1], 6.5 * px, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      });
      ctx.setLineDash([]);
    }

    // Numbers where there is room for them (average distance on screen),
    // the hovered one always.
    const planArea = drawWidth * pointScaleX * drawHeight * pointScaleY;
    const roomy =
      positioned.length > 0 &&
      Math.sqrt(planArea / positioned.length) / px >= LABEL_SPACING;
    drawOrder.forEach(({ item, start, end }) => {
      if (!roomy && item !== hovered) {
        return;
      }
      const [x, y] = end ? [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2] : start;
      drawLabel(
        lineMode ? `dm ${item.label}` : item.label,
        x + 9 * px,
        end ? y - 9 * px : y,
        item === hovered ? '#101419' : '#343a40',
        item === hovered ? 13 : 11,
      );
    });

    // "Align": each pin's target (crosshair, numbered) and a dashed line from
    // where its sensor point lies now - the lines vanish once it fits; the
    // sensor being dragged follows the mouse.
    if (aligning) {
      pins.forEach((pin, number) => {
        const target = fractionToCanvas(pin.target);
        pinLine(normalizedToCanvas(pin.source, transform), target, '#0d6efd');
        pinMark(target, number, '#0d6efd');
      });
      if (alignDrag) {
        const from = normalizedToCanvas(alignDrag.source, transform);
        pinLine(from, alignDrag.at, '#0d6efd');
        ctx.beginPath();
        ctx.arc(alignDrag.at[0], alignDrag.at[1], 7 * px, 0, Math.PI * 2);
        ctx.fillStyle = shownItems[alignDrag.index]?.color ?? '#0d6efd';
        ctx.fill();
        ctx.lineWidth = 2 * px;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
    }

    // Calibration: the two picked points and the line between them.
    if (calibrationPoints.length) {
      const [first, second] = calibrationPoints.map(toCanvas);
      ctx.strokeStyle = '#fd7e14';
      ctx.fillStyle = '#fd7e14';
      ctx.lineWidth = 2 * px;
      if (second) {
        ctx.beginPath();
        ctx.moveTo(first[0], first[1]);
        ctx.lineTo(second[0], second[1]);
        ctx.stroke();
      }
      [first, second].filter(Boolean).forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x, y, 5 * px, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // Reference point (origin of the positions in meters): a crosshair.
    if (referencePoint) {
      const [x, y] = toCanvas(referencePoint);
      ctx.strokeStyle = '#0d6efd';
      ctx.lineWidth = 2 * px;
      ctx.beginPath();
      ctx.moveTo(x - 12 * px, y);
      ctx.lineTo(x + 12 * px, y);
      ctx.moveTo(x, y - 12 * px);
      ctx.lineTo(x, y + 12 * px);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 6 * px, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [
    editMode,
    selection,
    pointSelect,
    selectColor,
    selectedItems,
    group,
    groupDrag,
    insertGhost,
    referencePoint,
    calibrationPoints,
    image,
    shownItems,
    hover,
    aligning,
    pins,
    alignDrag,
    lineMode,
    pixelRatio,
    px,
    placement,
    offsetX,
    offsetY,
    pointOffsetX,
    pointOffsetY,
    pointScaleX,
    pointScaleY,
    isVerticallyFlipped,
    zoom,
  ]);

  // Two picked points + their real distance -> meters per image pixel.
  const calibrationPixels =
    calibrationPoints.length === 2
      ? Math.hypot(
          calibrationPoints[1][0] - calibrationPoints[0][0],
          calibrationPoints[1][1] - calibrationPoints[0][1],
        )
      : null;
  useEffect(() => {
    const meters = Number(calibrationMeters.replace(',', '.'));
    if (calibrationPixels && Number.isFinite(meters) && meters > 0) {
      setMetersPerPixel(String(meters / calibrationPixels));
    }
  }, [calibrationPixels, calibrationMeters]);

  const parsedMetersPerPixel = Number(metersPerPixel.replace(',', '.'));
  const validMetersPerPixel =
    Number.isFinite(parsedMetersPerPixel) && parsedMetersPerPixel > 0
      ? parsedMetersPerPixel
      : null;

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (selectMoveRef.current?.(event)) {
        return;
      }
      if (!dragRef.current) {
        return;
      }

      // Mouse travel in screen pixels -> canvas units: the plan follows the mouse.
      const dx = (event.clientX - dragRef.current.startX) / screenScaleRef.current;
      const dy = (event.clientY - dragRef.current.startY) / screenScaleRef.current;
      setOffsetX(dragRef.current.startOffsetX + dx);
      setOffsetY(dragRef.current.startOffsetY + dy);
    };

    const handleMouseUp = () => {
      dragRef.current = null;
      selectingRef.current = false;
      setSelecting(false);
      // Released off the canvas: the "Align" drag is dropped (on it, the
      // canvas pins it first - see handleCanvasMouseUp).
      setAlignDrag(null);
      setGroupDrag(null);
      sensorDragRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  /** Zoom by `factor` around a canvas point (default: the middle) - the
   * plan point there stays where it is. */
  const zoomAround = (factor: number, at?: ImagePoint) => {
    const [pointerX, pointerY] = at ?? [CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2];
    const nextZoom = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const ratio = 1 - nextZoom / zoom;
    setZoom(nextZoom);
    setOffsetX(offsetX + (pointerX - CANVAS_WIDTH / 2 - offsetX) * ratio);
    setOffsetY(offsetY + (pointerY - CANVAS_HEIGHT / 2 - offsetY) * ratio);
  };
  const resetView = () => {
    setZoom(1);
    setOffsetX(0);
    setOffsetY(0);
  };
  const zoomAroundRef = useRef(zoomAround);
  zoomAroundRef.current = zoomAround;

  // Ctrl (or ⌘) + wheel zooms (isZoomWheel); the plain wheel scrolls the
  // page and only shows how to zoom. Native listener: React's wheel handler
  // is passive and can't keep the page from scrolling.
  const [wheelHint, showWheelHint] = useWheelHint();
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }
    const onWheel = (event: WheelEvent) => {
      if (!isZoomWheel(event)) {
        showWheelHint();
        return;
      }
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        return;
      }
      const delta = clamp(event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY, -120, 120);
      zoomAroundRef.current(Math.exp(-delta * 0.0015), [
        ((event.clientX - rect.left) * CANVAS_WIDTH) / rect.width,
        ((event.clientY - rect.top) * CANVAS_HEIGHT) / rect.height,
      ]);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [showWheelHint]);

  /** Canvas unit (LOGICAL) under the mouse - the canvas is shown at any width. */
  const canvasPointAt = (
    event: { clientX: number; clientY: number },
  ): ImagePoint | null => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return null;
    }
    return [
      ((event.clientX - rect.left) * CANVAS_WIDTH) / rect.width,
      ((event.clientY - rect.top) * CANVAS_HEIGHT) / rect.height,
    ];
  };

  /** Image pixel under the mouse, or null outside the plan. */
  const imagePointAt = (
    event: React.MouseEvent<HTMLCanvasElement>,
  ): ImagePoint | null => {
    const canvas = canvasRef.current;
    const canvasPoint = canvasPointAt(event);
    if (!canvas || !image || !canvasPoint) {
      return null;
    }
    const { scale, drawX, drawY } = canvasLayout(
      LOGICAL,
      image,
      zoom,
      offsetX,
      offsetY,
    );
    const x = (canvasPoint[0] - drawX) / scale;
    const y = (canvasPoint[1] - drawY) / scale;
    if (x < 0 || y < 0 || x > image.naturalWidth || y > image.naturalHeight) {
      return null;
    }
    return [x, y];
  };

  /** Image pixel under the mouse, moved onto the plan - a selection ends at its edge. */
  const imagePointOnPlan = (event: { clientX: number; clientY: number }): ImagePoint | null => {
    const canvasPoint = canvasPointAt(event);
    if (!image || !canvasPoint) {
      return null;
    }
    const { scale, drawX, drawY } = canvasLayout(LOGICAL, image, zoom, offsetX, offsetY);
    return [
      clamp((canvasPoint[0] - drawX) / scale, 0, image.naturalWidth),
      clamp((canvasPoint[1] - drawY) / scale, 0, image.naturalHeight),
    ];
  };
  // While a selection is dragged, the mouse anywhere on the page moves its
  // second corner (the window's mousemove, see above) - true if it did.
  const selectMoveRef = useRef<(event: MouseEvent) => boolean>(() => false);
  selectMoveRef.current = (event) => {
    if (!selectingRef.current) {
      return false;
    }
    const point = imagePointOnPlan(event);
    if (point) {
      setSelection((current) => (current ? [current[0], point] : current));
    }
    return true;
  };

  const pointTransform = (): PointTransform | null => {
    const canvas = canvasRef.current;
    if (!canvas || !image) {
      return null;
    }
    return {
      ...canvasLayout(LOGICAL, image, zoom, offsetX, offsetY),
      offsetX: pointOffsetX,
      offsetY: pointOffsetY,
      scaleX: pointScaleX,
      scaleY: pointScaleY,
      flipY: isVerticallyFlipped,
      zoom,
    };
  };

  /** Normalized position (nx/ny) under the mouse. */
  const normalizedPointAt = (
    event: React.MouseEvent<HTMLCanvasElement>,
  ): ImagePoint | null => {
    const transform = pointTransform();
    const canvasPoint = canvasPointAt(event);
    return transform && canvasPoint
      ? canvasToNormalized(canvasPoint, transform)
      : null;
  };

  /** The placed sensor under the mouse (topmost), if any. */
  const sensorAt = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const transform = pointTransform();
    const canvasPoint = canvasPointAt(event);
    if (!placement || !transform || !canvasPoint) {
      return null;
    }
    return (
      [...placement.sensors].reverse().find((sensor) => {
        const [x, y] = normalizedToCanvas([sensor.nx, sensor.ny], transform);
        return (
          Math.hypot(x - canvasPoint[0], y - canvasPoint[1]) <=
          (SENSOR_RADIUS + 3) * px
        );
      }) ?? null
    );
  };

  /** Index (into items) of the measure point / dm line under the mouse - the
   * closest within HOVER_TOLERANCE screen pixels - or null. */
  const itemAt = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const transform = pointTransform();
    const canvasPoint = canvasPointAt(event);
    if (placement || !transform || !canvasPoint) {
      return null;
    }
    let best: number | null = null;
    let bestDistance = HOVER_TOLERANCE * px;
    for (const [index, item] of shownItems.entries()) {
      const start = normalizedToCanvas(item.start, transform);
      const distance = item.end
        ? segmentDistance(canvasPoint, start, normalizedToCanvas(item.end, transform))
        : Math.hypot(start[0] - canvasPoint[0], start[1] - canvasPoint[1]);
      if (distance <= bestDistance) {
        best = index;
        bestDistance = distance;
      }
    }
    return best;
  };

  /** "Align" (A, L): the sensor under the mouse (as shown) and the grabbed
   * point on it - normalized, as stored (not where a group alignment shows
   * it); on a dm line where it was grabbed - or null. */
  const grabAt = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const index = itemAt(event);
    const transform = pointTransform();
    const at = canvasPointAt(event);
    if (index === null || !transform || !at) {
      return null;
    }
    const item = items[index];
    const shownItem = shownItems[index];
    if (!item.end || !shownItem.end) {
      return { index, source: item.start, at };
    }
    const [ax, ay] = normalizedToCanvas(shownItem.start, transform);
    const [bx, by] = normalizedToCanvas(shownItem.end, transform);
    const lengthSq = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = lengthSq ? clamp(((at[0] - ax) * (bx - ax) + (at[1] - ay) * (by - ay)) / lengthSq, 0, 1) : 0;
    const source: ImagePoint = [
      item.start[0] + t * (item.end[0] - item.start[0]),
      item.start[1] + t * (item.end[1] - item.start[1]),
    ];
    return { index, source, at };
  };

  /** Fraction of the plan image (0..1, y down) at a canvas point. */
  const imageFractionAt = ([x, y]: ImagePoint): ImagePoint | null => {
    if (!image) {
      return null;
    }
    const { drawX, drawY, drawWidth, drawHeight } = canvasLayout(LOGICAL, image, zoom, offsetX, offsetY);
    return [(x - drawX) / drawWidth, (y - drawY) / drawHeight];
  };

  // A dragged sensor dropped on the plan: pinned there (again, if it was).
  const handleCanvasMouseUp = () => {
    if (groupDrag) {
      const target = imageFractionAt(groupDrag.at);
      if (target && target.every((value) => value >= -0.05 && value <= 1.05)) {
        const pin = { id: groupDrag.id, source: groupDrag.source, target };
        setGroup((current) =>
          current ? { ...current, pins: [...current.pins.filter((existing) => existing.id !== pin.id), pin] } : current,
        );
      }
      setGroupDrag(null);
      return;
    }
    if (!alignDrag) {
      return;
    }
    const target = imageFractionAt(alignDrag.at);
    if (target && target.every((value) => value >= -0.05 && value <= 1.05)) {
      const pin = { index: alignDrag.index, source: alignDrag.source, target };
      setPins((current) => [...current.filter((existing) => existing.index !== pin.index), pin]);
    }
    setAlignDrag(null);
  };

  /** Shows (and so stores, see below) an alignment on the sliders. */
  const showAlignment = (values: AlignmentValues) => {
    setPointOffsetX(values.offsetX);
    setPointOffsetY(values.offsetY);
    setPointScaleX(values.scaleX);
    setPointScaleY(values.scaleY);
    setIsVerticallyFlipped(values.flipY);
  };

  // Auto alignment: the backend fits the points onto the plan's orange lines
  // (dm bands / sensors of the CAD drawing), starting from what is shown.
  const runAutoAlign = () => {
    const before: AlignmentValues = {
      offsetX: pointOffsetX,
      offsetY: pointOffsetY,
      scaleX: pointScaleX,
      scaleY: pointScaleY,
      flipY: isVerticallyFlipped,
    };
    setAutoAlign({ busy: true });
    void axiosConfig.perform_post(
      auth,
      '/v1/status/measure_points/auto_align/',
      {
        location_id: locationId,
        lageplan_id: lageplanId,
        offset_x: before.offsetX,
        offset_y: before.offsetY,
        scale_x: before.scaleX,
        scale_y: before.scaleY,
        flip_y: before.flipY,
      },
      (response) => {
        const data = (response?.data ?? {}) as {
          offset_x: number;
          offset_y: number;
          scale_x: number;
          scale_y: number;
          flip_y: boolean;
          score: number;
          matched: boolean;
        };
        showAlignment({
          offsetX: data.offset_x,
          offsetY: data.offset_y,
          scaleX: data.scale_x,
          scaleY: data.scale_y,
          flipY: data.flip_y,
        });
        setAutoAlign({ busy: false, score: data.score, matched: data.matched, before });
      },
      (error) => {
        const reason = (error as { response?: { data?: { reason?: string } } })?.response?.data?.reason;
        setAutoAlign({ busy: false, error: reason || 'The auto alignment failed' });
      },
    );
  };

  // The point calibration ends with "Store alignment" or "Cancel" (restore).
  const stopAligning = (restore: boolean) => {
    if (restore && alignBefore) {
      showAlignment(alignBefore);
    }
    setAlignBefore(null);
    setPins([]);
    setAlignDrag(null);
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (selectingRef.current) {
      return;
    }
    if (heldKey === 'i' && canInsert) {
      setInsertAt(normalizedPointAt(event));
    }
    if (groupDrag) {
      const at = canvasPointAt(event);
      if (at) {
        setGroupDrag({ ...groupDrag, at });
      }
      return;
    }
    if (alignDrag) {
      const at = canvasPointAt(event);
      if (at) {
        setAlignDrag({ ...alignDrag, at });
      }
      return;
    }
    handleSensorMouseMove(event);
    // No tooltip while panning.
    const index = dragRef.current ? null : itemAt(event);
    if (index === null) {
      setHover((current) => (current ? null : current));
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setHover({ index, x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  const handleSensorMouseMove = (
    event: React.MouseEvent<HTMLCanvasElement>,
  ) => {
    if (!placement || sensorDragRef.current === null) {
      return;
    }
    const point = normalizedPointAt(event);
    if (point) {
      placement.onMove(
        sensorDragRef.current,
        clamp(point[0], 0, 1),
        clamp(point[1], 0, 1),
      );
    }
  };

  // A click (not a pan) on the plan places the active sensor.
  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (
      !placement ||
      placement.activeDeviceId === null ||
      !press ||
      Math.hypot(event.clientX - press.x, event.clientY - press.y) >
        CLICK_TOLERANCE
    ) {
      return;
    }
    const point = normalizedPointAt(event);
    if (point && point.every((value) => value >= 0 && value <= 1)) {
      placement.onPlace(point[0], point[1]);
    }
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    pressRef.current = null;
    // I held: a click inserts the cut points there.
    if (heldKey === 'i' && canInsert) {
      const point = normalizedPointAt(event);
      if (point && !editBusy) {
        setInsertAt(point);
        insertCut(point);
      }
      return;
    }
    // Group alignment (L): a press on one of its points drags it to its
    // place (elsewhere, or with Shift, it pans).
    if (group && !event.shiftKey) {
      const grabbed = grabAt(event);
      const id = grabbed ? Number(items[grabbed.index].point.id) : NaN;
      if (grabbed && image && group.ids.has(id)) {
        const size = [image.naturalWidth, image.naturalHeight] as const;
        const source = toFraction(grabbed.source, planAlignment, ...size, alignmentBaseScale(...size));
        setGroupDrag({ id, source, at: grabbed.at });
        setHover(null);
        return;
      }
    }
    // Image edit (C / X) or a point selection (D / O / L held, then on until
    // its button, Cancel or Esc): a drag selects the area - a new one
    // replaces it, Shift + drag still pans.
    const heldSelect = heldKey ? SELECT_KEYS[heldKey] : undefined;
    const startHeld = heldSelect != null && canSelectFor(heldSelect) && !aligning && !group;
    const mode: SelectMode | null = startHeld ? heldSelect : group ? null : editMode;
    if (mode && canSelectFor(mode) && !editBusy && !event.shiftKey) {
      const point = imagePointOnPlan(event);
      if (point) {
        setEditMode(mode);
        setSelection([point, point]);
        selectingRef.current = true;
        setSelecting(true);
        setEditError('');
        setHover(null);
      }
      return;
    }
    // A held: a press on a sensor drags it to its place (elsewhere it pans);
    // the first one remembers the alignment before, for "Cancel".
    if (alignKey && canAlign && !group && tool !== 'reference') {
      const grabbed = grabAt(event);
      if (grabbed) {
        if (!aligning) {
          setAlignBefore({
            offsetX: pointOffsetX,
            offsetY: pointOffsetY,
            scaleX: pointScaleX,
            scaleY: pointScaleY,
            flipY: isVerticallyFlipped,
          });
        }
        setAlignDrag(grabbed);
        setHover(null);
        return;
      }
    }
    // R held (or the reference tool): a press sets the reference point.
    if (canScale && (heldKey === 'r' || tool === 'reference')) {
      const point = imagePointAt(event);
      if (point) {
        setReferencePoint(point);
        setTool('pan');
      }
      return;
    }
    // M held: a press picks a calibration point - a third starts a new measurement.
    if (canScale && heldKey === 'm') {
      const point = imagePointAt(event);
      if (point) {
        setTool('calibrate');
        setCalibrationPoints((current) =>
          current.length >= 2 ? [point] : [...current, point],
        );
      }
      return;
    }
    if (placement && tool === 'pan') {
      const sensor = sensorAt(event);
      if (sensor) {
        sensorDragRef.current = sensor.deviceId;
        placement.onSelect(sensor.deviceId);
        return;
      }
      pressRef.current = { x: event.clientX, y: event.clientY };
    }
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startOffsetX: offsetX,
      startOffsetY: offsetY,
    };
  };

  const storeAlignment = (values: AlignmentValues) => {
    if (onSaveSliders) {
      onSaveSliders(values);
      return;
    }
    void axiosConfig.perform_post(
      auth,
      '/v1/location/update/',
      {
        location_id: locationId,
        lageplan_id: lageplanId,
        offset_x: values.offsetX,
        offset_y: values.offsetY,
        scale_x: values.scaleX,
        scale_y: values.scaleY,
        flip_y: values.flipY,
      },
      () => {},
      () => {},
    );
  };

  // The alignment (sliders, flip, pins) is stored by itself, a moment after
  // the last change; one still pending is stored when the plan is left.
  const storedAlignRef = useRef<AlignmentValues>({
    offsetX: sourceMeta?.offset_x ?? 0,
    offsetY: sourceMeta?.offset_y ?? 0,
    scaleX: sourceMeta?.scale_x ?? 1,
    scaleY: sourceMeta?.scale_y ?? 1,
    flipY: sourceMeta?.flip_y ?? true,
  });
  const pendingAlignRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const values: AlignmentValues = {
      offsetX: pointOffsetX,
      offsetY: pointOffsetY,
      scaleX: pointScaleX,
      scaleY: pointScaleY,
      flipY: isVerticallyFlipped,
    };
    if (!withSliders || sameAlignment(values, storedAlignRef.current)) {
      pendingAlignRef.current = null;
      return undefined;
    }
    const store = () => {
      pendingAlignRef.current = null;
      // Stored meanwhile with an image edit - a crop has moved it since.
      if (sameAlignment(values, storedAlignRef.current)) {
        return;
      }
      storedAlignRef.current = values;
      storeAlignment(values);
    };
    pendingAlignRef.current = store;
    const timer = window.setTimeout(store, ALIGN_STORE_DELAY);
    return () => window.clearTimeout(timer);
    // storeAlignment changes every render - the values decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withSliders, pointOffsetX, pointOffsetY, pointScaleX, pointScaleY, isVerticallyFlipped]);
  useEffect(() => () => pendingAlignRef.current?.(), []);

  // The selected area in image pixels, once it can be applied.
  const selectionRect = (() => {
    if (!selection) {
      return null;
    }
    const [[ax, ay], [bx, by]] = selection;
    const rect = { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
    return rect.width >= MIN_SELECTION && rect.height >= MIN_SELECTION ? rect : null;
  })();

  /** "Apply": the server clears / crops the image and stores the alignment
   * shown with it (a crop moves it onto the cropped image); the new image
   * is loaded in place. */
  const applyEdit = () => {
    if (editMode === 'remove') {
      removePoints();
      return;
    }
    if (editMode === 'cut') {
      cutSelected();
      return;
    }
    if (editMode === 'group') {
      startGroup();
      return;
    }
    if (!editMode || !selectionRect) {
      return;
    }
    postImageEdit(editMode, { ...selectionRect });
  };

  /** Rotation by 90 degrees: the server turns the image and the plan's
   * measure points with it - they stay on the drawing. */
  const rotateImage = (clockwise: boolean) => postImageEdit('rotate', { direction: clockwise ? 'cw' : 'ccw' });

  /** Stores an image edit (measure_points/edit_lageplan) with the alignment shown. */
  const postImageEdit = (action: ImageEdit | 'rotate', extra: Record<string, unknown>) => {
    if (locationId == null || lageplanId == null) {
      return;
    }
    const values: AlignmentValues = {
      offsetX: pointOffsetX,
      offsetY: pointOffsetY,
      scaleX: pointScaleX,
      scaleY: pointScaleY,
      flipY: isVerticallyFlipped,
    };
    // Stored with the edit: a store still pending must not follow it.
    storedAlignRef.current = values;
    pendingAlignRef.current = null;
    setEditBusy(true);
    setEditError('');
    void axiosConfig.perform_post(
      auth,
      '/v1/status/measure_points/edit_lageplan/',
      {
        location_id: locationId,
        lageplan_id: lageplanId,
        action,
        ...extra,
        offset_x: values.offsetX,
        offset_y: values.offsetY,
        scale_x: values.scaleX,
        scale_y: values.scaleY,
        flip_y: values.flipY,
      },
      (response: { data?: Record<string, unknown> }) => {
        const answer = response?.data ?? {};
        const plan = (answer.lageplan ?? {}) as NonNullable<ImageCanvasStageProps['sourceMeta']>;
        setEditBusy(false);
        leaveEdit();
        if (action === 'crop' || action === 'rotate') {
          // The points keep their place on the plan: their alignment, the
          // reference point (image pixels) and the view start anew.
          const moved: AlignmentValues = {
            offsetX: plan.offset_x ?? 0,
            offsetY: plan.offset_y ?? 0,
            scaleX: plan.scale_x ?? 1,
            scaleY: plan.scale_y ?? 1,
            flipY: plan.flip_y ?? values.flipY,
          };
          storedAlignRef.current = moved;
          setPointOffsetX(moved.offsetX);
          setPointOffsetY(moved.offsetY);
          setPointScaleX(moved.scaleX);
          setPointScaleY(moved.scaleY);
          setIsVerticallyFlipped(moved.flipY);
          setReferencePoint(
            plan.reference_x != null && plan.reference_y != null ? [plan.reference_x, plan.reference_y] : null,
          );
          setCalibrationPoints([]);
          // Not a frame of the old image with the new alignment.
          setImage(null);
          resetView();
        }
        onImageEdited?.(answer);
      },
      (editFailure: unknown) => {
        setEditBusy(false);
        const what = { crop: 'crop the plan', clear: 'clear the area', rotate: 'rotate the plan' }[action];
        setEditError(`Could not ${what}: ${requestReason(editFailure)}`);
      },
    );
  };

  /** "Remove": the server deletes the selected measure points; the caller
   * drops them from what it shows (onPointsRemoved). */
  const removePoints = () => {
    if (!selectedIds.length || locationId == null) {
      return;
    }
    setEditBusy(true);
    setEditError('');
    void axiosConfig.perform_post(
      auth,
      '/v1/status/measure_points/remove/',
      { location_id: locationId, point_ids: selectedIds },
      (response: { data?: Record<string, unknown> }) => {
        setEditBusy(false);
        leaveEdit();
        setHover(null);
        onPointsRemoved?.(response?.data ?? {});
      },
      (removeFailure: unknown) => {
        setEditBusy(false);
        setEditError(`Could not remove the measure points: ${requestReason(removeFailure)}`);
      },
    );
  };

  /** "Cut": the selected points go to the caller's clipboard (onCut) -
   * nothing is stored before they are inserted (I + click). */
  const cutSelected = () => {
    const points = [...selectedItems].map((item) => item.point).filter((point) => Number.isInteger(Number(point.id)));
    if (!points.length) {
      return;
    }
    leaveEdit();
    setHover(null);
    onCut?.(points);
  };

  /** "Align N": the selected points are aligned by themselves (L) - drag
   * them onto their place, then "Apply". */
  const startGroup = () => {
    if (!selectedIds.length) {
      return;
    }
    const ids = new Set(selectedIds);
    leaveEdit();
    setGroup({ ids, pins: [] });
  };

  /** Moves points onto this plan at new normalized positions (measure_points/place). */
  const placePoints = (
    positions: Array<{ id: number; start: ImagePoint; end: ImagePoint | null }>,
    action: 'insert' | 'align',
    onDone: () => void,
  ) => {
    if (locationId == null || lageplanId == null) {
      return;
    }
    setEditBusy(true);
    setEditError('');
    void axiosConfig.perform_post(
      auth,
      '/v1/status/measure_points/place/',
      {
        location_id: locationId,
        lageplan_id: lageplanId,
        points: positions.map(({ id, start, end }) => ({
          id,
          nx: start[0],
          ny: start[1],
          ...(end ? { nx_end: end[0], ny_end: end[1] } : {}),
        })),
      },
      (response: { data?: Record<string, unknown> }) => {
        setEditBusy(false);
        setHover(null);
        onDone();
        onPointsPlaced?.(response?.data ?? {}, action);
      },
      (placeFailure: unknown) => {
        setEditBusy(false);
        setEditError(
          `Could not ${action === 'insert' ? 'insert the cut points' : 'store the aligned points'}: ${requestReason(placeFailure)}`,
        );
      },
    );
  };

  // I + click: the cut points onto this plan, their middle at the click.
  const insertCut = (at: ImagePoint) => {
    const placed = cutPlacedAt(cutItems, at);
    if (placed) {
      placePoints(placed, 'insert', () => setInsertAt(null));
    }
  };

  // Group "Apply": the group's points where the pins put them.
  const storeGroup = () => {
    if (!group || !groupTransform) {
      return;
    }
    placePoints(
      shownItems
        .filter((item) => group.ids.has(Number(item.point.id)))
        .map((item) => ({ id: Number(item.point.id), start: item.start, end: item.end })),
      'align',
      leaveGroup,
    );
  };

  const sliders: Array<{
    id: string;
    label: string;
    value: number;
    display: string;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
  }> = [
    {
      id: 'point-offset-x',
      label: 'Offset X',
      value: pointOffsetX,
      display: String(pointOffsetX),
      min: -250,
      max: 250,
      step: 1,
      onChange: setPointOffsetX,
    },
    {
      id: 'point-offset-y',
      label: 'Offset Y',
      value: pointOffsetY,
      display: String(pointOffsetY),
      min: -250,
      max: 250,
      step: 1,
      onChange: setPointOffsetY,
    },
    // Four decimals - "Align" computes them that precisely.
    {
      id: 'point-scale-x',
      label: 'Scale X',
      value: pointScaleX,
      display: pointScaleX.toFixed(4),
      min: 0.1,
      max: 5,
      step: 0.0001,
      onChange: setPointScaleX,
    },
    {
      id: 'point-scale-y',
      label: 'Scale Y',
      value: pointScaleY,
      display: pointScaleY.toFixed(4),
      min: 0.1,
      max: 5,
      step: 0.0001,
      onChange: setPointScaleY,
    },
  ];
  const alignProblem = alignFit && 'problem' in alignFit ? alignFit.problem : null;
  const alignError = alignFit && 'alignment' in alignFit ? alignFit.alignment.errorPx : null;

  /** What the tooltip of a measure point / dm line tells. */
  const tooltipRows = (item: MarkerItem): Array<[string, string]> => {
    const { point } = item;
    const rows: Array<[string, string]> = [];
    if (point.name) {
      rows.push(['Name', String(point.name)]);
    }
    if (point.device != null) {
      const deviceId = Number(point.device);
      rows.push(['Device', deviceLabels?.[deviceId] ?? `#${deviceId}`]);
      // Which pair of the device's measurements is this sensor.
      const start = devicePairStarts?.[deviceId];
      if (start != null) {
        rows.push(['Pair', String(Number(item.label) - start + 1)]);
      }
    }
    if (item.end) {
      if (image && validMetersPerPixel) {
        // Meters per pixel of the plan image, the band as the plan shows it.
        const pixels = Math.hypot(
          (item.end[0] - item.start[0]) * image.naturalWidth * pointScaleX,
          (item.end[1] - item.start[1]) * image.naturalHeight * pointScaleY,
        );
        rows.push(['Length', `${(pixels * validMetersPerPixel).toFixed(1)} m`]);
      } else {
        // x/y are CAD coordinates times 10 (cad_reader.normalize_points).
        const length =
          Math.hypot(finite(point.x_end) - finite(point.x), finite(point.y_end) - finite(point.y)) / 10;
        if (Number.isFinite(length)) {
          rows.push(['Length', `${length.toFixed(1)} CAD units`]);
        }
      }
    } else if (lineMode) {
      rows.push(['Band', 'not in the plan - shown at its label']);
    }
    if (point.threshold != null) {
      rows.push(['Threshold', String(point.threshold)]);
    }
    if (point.last_value != null) {
      rows.push(['Last value', String(point.last_value)]);
    }
    return rows;
  };

  const hoveredItem = hover ? (items[hover.index] ?? null) : null;
  const cssHeight = (cssWidth * CANVAS_HEIGHT) / CANVAS_WIDTH;
  const tooltipBelow = hover ? hover.y < cssHeight - 140 : true;
  const editing = editMode != null && canSelectFor(editMode);
  const selectingPoints = editing && pointSelect != null;
  const pointNoun = lineMode ? 'dm sensor' : 'measure point';
  // What D / O / L + drag do, for the badge and the button under the selection.
  const POINT_ACTIONS: Record<PointSelect, { name: string; doing: string; button: string }> = {
    remove: { name: 'Remove', doing: 'to remove', button: 'Remove' },
    cut: { name: 'Cut out', doing: 'to cut out - insert them with I', button: 'Cut' },
    group: { name: 'Align a group', doing: 'to align by themselves', button: 'Align' },
  };
  const heldSelect = heldKey ? SELECT_KEYS[heldKey] : undefined;
  const pointBadge = (mode: PointSelect, selected: boolean) =>
    selected
      ? `${POINT_ACTIONS[mode].name}: ${selectedIds.length} ${pointNoun}(s) selected · Esc cancels`
      : `${POINT_ACTIONS[mode].name}: drag over the ${pointNoun}s ${POINT_ACTIONS[mode].doing}`;
  // "Apply" floats below the selection's lower right corner (CSS pixels), on the canvas.
  const applyAt = (() => {
    if (!editing || !selectionRect || selecting || !image) {
      return null;
    }
    const { scale, drawX, drawY } = canvasLayout(LOGICAL, image, zoom, offsetX, offsetY);
    const right = (drawX + (selectionRect.x + selectionRect.width) * scale) * screenScale;
    const bottom = (drawY + (selectionRect.y + selectionRect.height) * scale) * screenScale;
    return {
      left: clamp(right - 190, 8, Math.max(8, cssWidth - 198)),
      top: clamp(bottom + 8, 8, Math.max(8, cssHeight - 44)),
    };
  })();
  const badgeColor = editing
    ? editMode === 'crop'
      ? '#0d6efd'
      : selectColor
    : heldKey === 'i' && canInsert
      ? CUT_COLOR
      : group
        ? GROUP_COLOR
        : heldSelect && canSelectFor(heldSelect)
          ? { remove: REMOVE_COLOR, cut: CUT_COLOR, group: GROUP_COLOR }[heldSelect]
          : '#0d6efd';
  const badge = editing
    ? editMode === 'crop'
      ? 'Crop: drag the area to keep · Esc cancels'
      : pointSelect
        ? pointBadge(pointSelect, selectionRect != null && !selecting)
        : 'Clear: drag over the area to fill white · Esc cancels'
    : heldKey === 'i' && canInsert
      ? `Insert ${cutItems.length} cut ${pointNoun}(s): click where their middle goes`
    : group
      ? `Align ${group.ids.size} ${pointNoun}(s): drag them onto their place · Esc cancels`
    : heldSelect && canSelectFor(heldSelect) && !aligning
      ? pointBadge(heldSelect, false)
    : alignKey && canAlign
      ? `Align: drag a ${lineMode ? 'dm line' : 'sensor'} onto its right place`
      : canScale && heldKey === 'r'
        ? 'Reference point: click it on the plan'
        : canScale && heldKey === 'm'
          ? `Calibrate: click ${calibrationPoints.length === 1 ? 'the second' : 'the first'} point of a known distance`
          : null;

  return (
    <div className="d-flex flex-column gap-3" data-testid={testId}>
      <div className="d-flex justify-content-between align-items-baseline gap-2 flex-wrap">
        <span className="image-canvas-title" data-testid={childTestId(testId, 'title')}>{title}</span>
        {fileName && (
          <span className="image-canvas-muted" data-testid={childTestId(testId, 'file-name')}>{fileName}</span>
        )}
      </div>

      <div className="d-flex flex-column gap-2">
        <div className="image-canvas-wrap">
          <canvas
            ref={canvasRef}
            width={Math.round(CANVAS_WIDTH * pixelRatio)}
            height={Math.round(CANVAS_HEIGHT * pixelRatio)}
            onMouseDown={handleMouseDown}
            onMouseUp={handleCanvasMouseUp}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHover(null)}
            onClick={handleClick}
            className={`image-canvas-stage-canvas image-canvas-stage-canvas--${
              editing ||
              (heldSelect && canSelectFor(heldSelect)) ||
              (heldKey === 'i' && canInsert) ||
              tool === 'reference' ||
              placement?.activeDeviceId != null ||
              (canScale && (heldKey === 'r' || heldKey === 'm'))
                ? 'crosshair'
                : dragRef.current || alignDrag || groupDrag
                  ? 'grabbing'
                  : group && hoveredItem && group.ids.has(Number(hoveredItem.point.id))
                    ? 'grab'
                  : alignKey && canAlign
                    ? hoveredItem
                      ? 'grab'
                      : 'crosshair'
                  : hoveredItem
                    ? 'pointer'
                    : 'grab'
            }`}
            style={{ aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}` }}
            data-testid={childTestId(testId, 'canvas')}
          />
          <ZoomControls
            onZoomIn={() => zoomAround(ZOOM_STEP)}
            onZoomOut={() => zoomAround(1 / ZOOM_STEP)}
            onReset={resetView}
            zoomOutDisabled={zoom <= MIN_ZOOM}
            resetDisabled={zoom === 1 && offsetX === 0 && offsetY === 0}
            testId={childTestId(testId, 'zoom')}
          />
          <WheelZoomHint visible={wheelHint} testId={childTestId(testId, 'wheel-hint')} />
          {canEditImage && !editing && (
            // Turns the image by 90 degrees - the measure points turn with it.
            <div className="image-canvas-rotate d-flex gap-1">
              {([false, true] as const).map((clockwise) => (
                <button
                  key={String(clockwise)}
                  type="button"
                  className="image-canvas-rotate-button btn btn-sm btn-light d-inline-flex align-items-center justify-content-center"
                  title={clockwise ? 'Rotate 90° clockwise' : 'Rotate 90° counterclockwise'}
                  aria-label={clockwise ? 'Rotate the plan 90° clockwise' : 'Rotate the plan 90° counterclockwise'}
                  disabled={editBusy || aligning}
                  onClick={() => rotateImage(clockwise)}
                  data-testid={childTestId(testId, 'rotate')}
                  data-test-key={clockwise ? 'clockwise' : 'counterclockwise'}
                >
                  {clockwise ? <ArrowClockwise size={15} /> : <ArrowCounterclockwise size={15} />}
                </button>
              ))}
            </div>
          )}
          {badge && (
            <div
              aria-live="polite"
              className="image-canvas-badge"
              data-testid={childTestId(testId, 'badge')}
              style={{ background: badgeColor }}
            >
              {badge}
            </div>
          )}
          {applyAt && (
            <div className="image-canvas-apply d-flex gap-2" style={applyAt} data-testid={childTestId(testId, 'apply-bar')}>
              <button
                type="button"
                className={`image-canvas-pill image-canvas-pill--raised btn btn-sm ${editMode === 'crop' ? 'btn-primary' : 'btn-danger'}`}
                // The colour of the point action (cut / group) in use.
                style={
                  pointSelect && pointSelect !== 'remove'
                    ? { background: selectColor, borderColor: selectColor, color: '#ffffff' }
                    : undefined
                }
                disabled={editBusy || (selectingPoints && selectedIds.length === 0)}
                onClick={applyEdit}
                data-testid={childTestId(testId, 'apply')}
              >
                {editBusy
                  ? 'Applying…'
                  : selectingPoints && pointSelect
                    ? `${POINT_ACTIONS[pointSelect].button} ${selectedIds.length}`
                    : 'Apply'}
              </button>
              <button
                type="button"
                className="image-canvas-pill image-canvas-pill--raised btn btn-sm btn-light"
                disabled={editBusy}
                onClick={leaveEdit}
                data-testid={childTestId(testId, 'apply-cancel')}
              >
                Cancel
              </button>
            </div>
          )}
          {hover && hoveredItem && (
            <div
              role="tooltip"
              data-testid={childTestId(testId, 'tooltip')}
              className={tooltipBelow ? 'image-canvas-tooltip' : 'image-canvas-tooltip image-canvas-tooltip--above'}
              style={{
                left: clamp(hover.x + 14, 4, Math.max(4, cssWidth - 244)),
                top: tooltipBelow ? hover.y + 16 : hover.y - 16,
              }}
            >
              <div className="image-canvas-tooltip-title d-flex align-items-center gap-2">
                <span className="image-canvas-tooltip-dot" style={{ background: hoveredItem.color }} />
                {lineMode ? `dm ${hoveredItem.label}` : `Sensor ${hoveredItem.label}`}
              </div>
              {tooltipRows(hoveredItem).map(([label, value]) => (
                <div key={label} className="d-flex gap-2">
                  <span className="image-canvas-tooltip-label">{label}</span>
                  <span className="ms-auto text-end">{value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          className="image-canvas-muted image-canvas-footer d-flex justify-content-between align-items-center gap-2 flex-wrap"
          data-testid={childTestId(testId, 'footer')}
        >
          <span data-testid={childTestId(testId, 'zoom-level')}>Zoom {zoom.toFixed(2)}×</span>
          {!placement && items.length > 1 && (
            <span className="d-flex align-items-center gap-2">
              <span>{lineMode ? `dm ${items[0].label}` : items[0].label}</span>
              <span
                aria-hidden="true"
                className="image-canvas-rainbow"
                style={{ background: RAINBOW_GRADIENT }}
              />
              <span>{items[items.length - 1].label}</span>
              {lineMode && (
                <span>
                  · {lineCount} line(s)
                  {items.length > lineCount ? ` · ${items.length - lineCount} without band` : ''}
                </span>
              )}
            </span>
          )}
        </div>

        <CanvasKeyLegend
          testId={childTestId(testId, 'legend')}
          groups={[
            {
              title: 'View',
              entries: [
                { keys: editing ? ['Shift', 'Drag'] : ['Drag'], label: 'Move the plan' },
                { keys: ['Ctrl', 'Scroll'], label: 'Zoom - or the buttons on the plan' },
                !placement && { keys: ['Hover'], label: 'Details of a sensor' },
              ],
            },
            placement && {
              title: 'Place sensors',
              entries: [
                {
                  keys: ['Click'],
                  label:
                    placement.activeDeviceId != null
                      ? `Place ${placement.activeLabel ?? 'the selected sensor'}`
                      : 'Place the sensor selected in step 3',
                  active: placement.activeDeviceId != null && !editing,
                },
                { keys: ['Drag'], label: 'Move a placed sensor (drag the dot)' },
              ],
            },
            (canAlign || canScale) && {
              title: 'Align and scale',
              entries: [
                canAlign && {
                  keys: ['A', 'Drag'],
                  label: `Hold A, drag a ${lineMode ? 'dm line' : 'sensor'} onto its place`,
                  active: alignKey || aligning,
                },
                canScale && {
                  keys: ['R', 'Click'],
                  label: 'Hold R, click the reference point',
                  active: heldKey === 'r' || tool === 'reference',
                },
                canScale && {
                  keys: ['M', 'Click'],
                  label: 'Hold M, click two points of a known distance',
                  active: heldKey === 'm',
                },
              ],
            },
            canEditImage && {
              title: 'Edit the image',
              entries: [
                { keys: ['C'], label: 'Clear an area - fill it white', active: editMode === 'clear' },
                { keys: ['X'], label: 'Crop the plan to an area', active: editMode === 'crop' },
                { keys: ['↺ / ↻'], label: 'Rotate the plan by 90° (buttons on the plan) - the sensors turn with it' },
                editing && !selectingPoints && {
                  keys: ['Drag'],
                  label: selectionRect ? 'Select the area again' : 'Select the area',
                  active: !selectionRect,
                },
                { keys: ['Esc'], label: 'Cancel' },
              ],
              note: 'Nothing changes before "Apply" - the sensors keep their place.',
            },
            (canRemovePoints || canCut || canGroup || canInsert) && {
              title: lineMode ? 'dm sensors' : 'Measure points',
              entries: [
                canRemovePoints && {
                  keys: ['D', 'Drag'],
                  label: `Hold D, drag over ${pointNoun}s to remove them`,
                  active: heldKey === 'd' || editMode === 'remove',
                },
                canCut && {
                  keys: ['O', 'Drag'],
                  label: `Hold O, drag over ${pointNoun}s to cut them out`,
                  active: heldKey === 'o' || editMode === 'cut',
                },
                canInsert && {
                  keys: ['I', 'Click'],
                  label: `Hold I, click where the ${cutItems.length} cut one(s) go - on any plan`,
                  active: heldKey === 'i',
                },
                canGroup && {
                  keys: ['L', 'Drag'],
                  label: `Hold L, drag over ${pointNoun}s to align them by themselves`,
                  active: heldKey === 'l' || editMode === 'group' || group != null,
                },
                { keys: ['Esc'], label: 'Cancel' },
              ],
              note: `Removing is for good once "Remove" is pressed; cut ${pointNoun}s stay where they were until inserted. All keep their number.`,
            },
          ]}
        />

        {!placement && lineSensors && items.length > 0 && lineCount === 0 && (
          <div className="image-canvas-action image-canvas-action--warning" data-testid={childTestId(testId, 'no-lines-warning')}>
            This is a smartex dm project, but these measure points have no band
            ends - import the DWG/DXF again in step 3 to get the sensor lines.
          </div>
        )}
      </div>

      {group && (
        <div
          className="image-canvas-action image-canvas-action--group d-flex flex-wrap align-items-center gap-2"
          data-testid={childTestId(testId, 'group')}
        >
          <div className="image-canvas-action-text">
            <div className="image-canvas-action-title">
              Aligning {group.ids.size} {pointNoun}(s) by themselves · {group.pins.length} pinned
            </div>
            <div>
              {groupFit && 'problem' in groupFit && group.pins.length
                ? groupFit.problem
                : group.pins.length === 0
                  ? `Drag one of them onto its place - one pin moves the group, two or more far apart also scale it. The plan's alignment and the other ${pointNoun}s stay.`
                  : group.pins.length === 1
                    ? 'Moved by the pin. Drag another one, far from the first, to scale them too - or apply.'
                    : 'Moved and scaled by the pins. Dragging one again moves its pin.'}
            </div>
          </div>
          <button
            type="button"
            className="image-canvas-pill btn btn-sm btn-outline-secondary"
            disabled={editBusy}
            onClick={leaveGroup}
            data-testid={childTestId(testId, 'group-cancel')}
          >
            Cancel
          </button>
          <button
            type="button"
            className="image-canvas-pill image-canvas-pill--group btn btn-sm"
            disabled={editBusy || !groupTransform || group.pins.length === 0}
            onClick={storeGroup}
            data-testid={childTestId(testId, 'group-apply')}
          >
            {editBusy ? 'Storing…' : 'Apply'}
          </button>
        </div>
      )}

      {cutItems.length > 0 && (
        <div
          className="image-canvas-action image-canvas-action--cut d-flex flex-wrap align-items-center gap-2"
          data-testid={childTestId(testId, 'cut')}
        >
          <div className="image-canvas-action-text">
            <div className="image-canvas-action-title">
              {cutItems.length} {pointNoun}(s) cut out
            </div>
            <div>
              {canInsert ? (
                <>
                  Hold <kbd className="canvas-key-badge">I</kbd> and click where they go - on this plan or another one. Until
                  then they stay where they were.
                </>
              ) : (
                'Open the plan they go onto to insert them. Until then they stay where they were.'
              )}
            </div>
          </div>
          {onDiscardCut && (
            <button
              type="button"
              className="image-canvas-pill btn btn-sm btn-outline-secondary"
              disabled={editBusy}
              onClick={onDiscardCut}
              data-testid={childTestId(testId, 'cut-discard')}
            >
              Put back
            </button>
          )}
        </div>
      )}

      {editError && (
        <div role="alert" className="image-canvas-action image-canvas-action--error" data-testid={childTestId(testId, 'edit-error')}>
          {editError}
        </div>
      )}

      {imageError && (
        <div className="image-canvas-action image-canvas-action--error" data-testid={childTestId(testId, 'image-error')}>
          {imageError}
        </div>
      )}

      {withSliders && (
        <div className="image-canvas-sub-panel" data-testid={childTestId(testId, 'alignment')}>
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <div>
              <div className="image-canvas-sub-title">Alignment</div>
              <div className="image-canvas-muted">
                Moves and scales the measure points onto the plan - stored
                automatically.
              </div>
            </div>
            <div className="ms-auto d-flex gap-2">
              {canAutoAlign && (
                <button
                  type="button"
                  className="image-canvas-pill image-canvas-auto btn btn-sm"
                  onClick={runAutoAlign}
                  disabled={autoAlign?.busy || aligning}
                  title="Lay the measure points onto the orange lines of the plan"
                  data-testid={childTestId(testId, 'auto-align')}
                >
                  {autoAlign?.busy ? (
                    <span className="spinner-border spinner-border-sm me-1" aria-hidden />
                  ) : (
                    <Magic className="me-1" aria-hidden />
                  )}
                  Auto-align
                </button>
              )}
              <button
                type="button"
                className={`image-canvas-pill btn btn-sm ${isVerticallyFlipped ? 'btn-secondary' : 'btn-outline-secondary'}`}
                aria-pressed={isVerticallyFlipped}
                onClick={() => setIsVerticallyFlipped((current) => !current)}
                data-testid={childTestId(testId, 'flip-vertical')}
              >
                Vertical flip
              </button>
            </div>
          </div>

          {autoAlign && !autoAlign.busy && (
            <div
              className={`image-canvas-action d-flex flex-wrap align-items-center gap-2 ${
                'error' in autoAlign
                  ? 'image-canvas-action--error'
                  : autoAlign.matched
                    ? 'image-canvas-action--align'
                    : 'image-canvas-action--warning'
              }`}
              data-testid={childTestId(testId, 'auto-align-result')}
            >
              <div className="image-canvas-action-text">
                {'error' in autoAlign ? (
                  autoAlign.error
                ) : (
                  <>
                    <div className="image-canvas-action-title">
                      {autoAlign.matched ? 'Aligned to the orange lines' : 'Only a rough match'}
                    </div>
                    {Math.round(autoAlign.score * 100)}% of the sensor points lie on the orange lines of the plan
                    {autoAlign.matched
                      ? ' - stored. Check it, fine-tune with the sliders or hold A.'
                      : ' - check the result, or undo and align by hand (hold A).'}
                  </>
                )}
              </div>
              {'before' in autoAlign && (
                <button
                  type="button"
                  className="image-canvas-pill btn btn-sm btn-outline-secondary"
                  onClick={() => {
                    showAlignment(autoAlign.before);
                    setAutoAlign(null);
                  }}
                  data-testid={childTestId(testId, 'auto-align-undo')}
                >
                  Undo
                </button>
              )}
              <button
                type="button"
                className="image-canvas-pill btn btn-sm btn-outline-secondary"
                onClick={() => setAutoAlign(null)}
                data-testid={childTestId(testId, 'auto-align-close')}
              >
                OK
              </button>
            </div>
          )}

          {canAlign && !aligning && (
            <div className="image-canvas-hint d-flex align-items-center gap-2" data-testid={childTestId(testId, 'align-hint')}>
              <kbd className="canvas-key-badge">A</kbd>
              <span>
                Hold <strong>A</strong> and drag a {lineMode ? 'dm line' : 'sensor'} onto its right place on
                the plan - two far apart (e.g. opposite corners) set the alignment, more refine it.
              </span>
            </div>
          )}

          {aligning && (
            <div
              className="image-canvas-action image-canvas-action--align d-flex flex-wrap align-items-center gap-2"
              data-testid={childTestId(testId, 'aligning')}
            >
              <div className="image-canvas-action-text">
                <div className="image-canvas-action-title">
                  {pins.length} {lineMode ? 'dm sensor(s)' : 'sensor(s)'} pinned
                </div>
                <div>
                  {alignProblem && pins.length >= ALIGN_PINS
                    ? alignProblem
                    : alignError != null
                      ? `Computed from the pins (stored) - off by at most ${alignError.toFixed(1)} px of the plan. Hold A and drag more to refine.`
                      : `Hold A and drag one more ${lineMode ? 'dm line' : 'sensor'} onto its place, far from the first. Dragging one again moves its pin.`}
                </div>
              </div>
              <button
                type="button"
                className="image-canvas-pill btn btn-sm btn-outline-secondary"
                onClick={() => stopAligning(true)}
                data-testid={childTestId(testId, 'align-cancel')}
              >
                Cancel
              </button>
              <button
                type="button"
                className="image-canvas-pill btn btn-sm btn-primary"
                onClick={() => stopAligning(false)}
                data-testid={childTestId(testId, 'align-done')}
              >
                Done
              </button>
            </div>
          )}

          <div className="image-canvas-sliders">
            {sliders.map((slider) => (
              <div key={slider.id}>
                <label
                  htmlFor={slider.id}
                  className="image-canvas-muted d-flex justify-content-between mb-0"
                >
                  <span>{slider.label}</span>
                  <span
                    className="image-canvas-slider-value font-monospace"
                    data-testid={childTestId(testId, 'slider-value')}
                    data-test-key={slider.id}
                  >
                    {slider.display}
                  </span>
                </label>
                <input
                  id={slider.id}
                  className="form-range"
                  type="range"
                  // A computed value outside the usual range widens it.
                  min={Math.min(slider.min, slider.value)}
                  max={Math.max(slider.max, slider.value)}
                  step={slider.step}
                  value={slider.value}
                  onChange={(event) =>
                    slider.onChange(Number(event.target.value))
                  }
                  data-testid={childTestId(testId, 'slider')}
                  data-test-key={slider.id}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {withSliders && onSaveScale && (
        <div className="image-canvas-sub-panel" data-testid={childTestId(testId, 'scale')}>
          <div>
            <div className="image-canvas-sub-title">Scale</div>
            <div className="image-canvas-muted">
              Positions in meters: x to the right, y up from the reference
              point.
            </div>
          </div>

          <div className="d-flex flex-wrap align-items-center gap-2">
            <button
              type="button"
              className={`image-canvas-pill btn btn-sm ${tool === 'reference' ? 'btn-primary' : 'btn-outline-primary'}`}
              onClick={() =>
                setTool((current) =>
                  current === 'reference' ? 'pan' : 'reference',
                )
              }
              data-testid={childTestId(testId, 'reference-point')}
            >
              Reference point
            </button>
            <span className="image-canvas-muted">
              {tool === 'reference'
                ? 'Click the reference point on the plan.'
                : referencePoint
                  ? `at pixel (${Math.round(referencePoint[0])}, ${Math.round(referencePoint[1])})`
                  : 'not set'}
            </span>
            {tool !== 'reference' && (
              <span className="image-canvas-muted d-flex align-items-center gap-1">
                · or hold <kbd className="canvas-key-badge">R</kbd> and click
              </span>
            )}
          </div>

          <div className="d-flex flex-wrap align-items-center gap-2">
            <button
              type="button"
              className={`image-canvas-pill btn btn-sm ${tool === 'calibrate' ? 'btn-primary' : 'btn-outline-primary'}`}
              onClick={() => {
                setTool((current) =>
                  current === 'calibrate' ? 'pan' : 'calibrate',
                );
                setCalibrationPoints([]);
              }}
              data-testid={childTestId(testId, 'calibrate')}
            >
              Calibrate
            </button>
            {calibrationPixels == null && (
              <span className="image-canvas-muted d-flex align-items-center gap-1">
                Hold <kbd className="canvas-key-badge">M</kbd> and click two points with a known distance
                {tool === 'calibrate' ? ` (${calibrationPoints.length}/2)` : ''}.
              </span>
            )}
            {calibrationPixels != null && (
              <>
                <span className="image-canvas-muted">
                  {calibrationPixels.toFixed(1)} px =
                </span>
                <input
                  type="number"
                  className="image-canvas-field image-canvas-field--distance form-control form-control-sm"
                  min="0"
                  step="0.01"
                  placeholder="meters"
                  aria-label="Distance in meters"
                  value={calibrationMeters}
                  onChange={(event) => setCalibrationMeters(event.target.value)}
                  data-testid={childTestId(testId, 'calibration-meters')}
                />
                <span className="image-canvas-muted">m</span>
              </>
            )}
          </div>

          <div className="d-flex flex-wrap align-items-center gap-2">
            <label
              className="image-canvas-muted mb-0"
              htmlFor="meters-per-pixel"
            >
              Meters per pixel
            </label>
            <input
              id="meters-per-pixel"
              type="number"
              className="image-canvas-field image-canvas-field--scale form-control form-control-sm"
              min="0"
              step="any"
              value={metersPerPixel}
              onChange={(event) => setMetersPerPixel(event.target.value)}
              data-testid={childTestId(testId, 'meters-per-pixel')}
            />
            <button
              type="button"
              className="image-canvas-pill btn btn-sm btn-primary ms-auto"
              disabled={!referencePoint && !validMetersPerPixel}
              onClick={() => {
                const values: PlanScaleValues = {};
                if (referencePoint) {
                  values.reference_x = referencePoint[0];
                  values.reference_y = referencePoint[1];
                }
                if (validMetersPerPixel) {
                  values.meters_per_pixel = validMetersPerPixel;
                }
                setTool('pan');
                onSaveScale(values);
              }}
              data-testid={childTestId(testId, 'scale-store')}
            >
              Store scale
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ImageCanvasStage;
