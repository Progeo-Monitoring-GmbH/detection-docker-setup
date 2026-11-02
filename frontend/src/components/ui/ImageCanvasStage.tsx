import { useEffect, useMemo, useRef, useState } from 'react';
import axiosConfig from '../../axiosConfig';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import ZoomControls from '../device/ZoomControls';
import { ALIGN_PINS, fitAlignment, type AlignPin } from './alignmentFit';
import { isZoomWheel, useWheelHint, WheelZoomHint } from './wheelZoom';

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

const MUTED = '#8B8383';
/** The control blocks under the canvas (alignment, scale). */
const SUB_PANEL: React.CSSProperties = {
  background: 'var(--progeo-surface)',
  borderRadius: 13,
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};
const PILL_BUTTON: React.CSSProperties = {
  borderRadius: 'var(--progeo-radius-pill)',
  height: 32,
  padding: '0 14px',
  fontSize: 12.5,
  fontWeight: 500,
};
const FIELD: React.CSSProperties = { borderRadius: 10, height: 32 };
/** A keyboard key in a hint. */
const KEY_BADGE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 24,
  height: 24,
  padding: '0 6px',
  borderRadius: 6,
  background: '#ffffff',
  color: 'var(--progeo-blue)',
  border: '1px solid #cfd4da',
  boxShadow: 'inset 0 -2px 0 #cfd4da',
  fontSize: 12,
  fontWeight: 700,
};
/** Mouse travel (px) up to which a press on the plan still counts as a click. */
const CLICK_TOLERANCE = 4;

/** Click tools: pan (default), place the metric reference point, or pick
 * the two points of a known distance for the meters-per-pixel calibration. */
type CanvasTool = 'pan' | 'reference' | 'calibrate';

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
  onSaveSliders?: (values: {
    offsetX: number;
    offsetY: number;
    scaleX: number;
    scaleY: number;
    flipY: boolean;
  }) => void;
  /** Stores the metric scale (reference point in image pixels, m/px). */
  onSaveScale?: (values: PlanScaleValues) => void;
  placement?: SensorPlacement;
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
  const [referencePoint, setReferencePoint] = useState<ImagePoint | null>(null);
  const [calibrationPoints, setCalibrationPoints] = useState<ImagePoint[]>([]);
  const [calibrationMeters, setCalibrationMeters] = useState('');
  const [metersPerPixel, setMetersPerPixel] = useState('');
  // The sensor under the mouse (index into items) and the mouse position
  // over the canvas in CSS pixels, for its tooltip.
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  // Point calibration: while A is held (alignKey), a sensor dragged onto its
  // place on the plan is pinned there - from the pins (by index into items)
  // the alignment is computed (alignmentFit); the values before are restored
  // on cancel. alignDrag: the sensor being dragged, the grabbed point on it
  // (normalized) and the mouse (canvas units).
  const [alignKey, setAlignKey] = useState(false);
  const [pins, setPins] = useState<Array<AlignPin & { index: number }>>([]);
  const [alignDrag, setAlignDrag] = useState<{ index: number; source: ImagePoint; at: ImagePoint } | null>(null);
  const aligning = pins.length > 0 || alignDrag != null;
  const [alignBefore, setAlignBefore] = useState<{
    offsetX: number;
    offsetY: number;
    scaleX: number;
    scaleY: number;
    flipY: boolean;
  } | null>(null);

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
  // A (no modifier, not typing) held: drags pin sensors; released on keyup or leaving the window.
  useEffect(() => {
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'a' && !event.ctrlKey && !event.metaKey && !event.altKey && !typing(event.target)) {
        setAlignKey(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'a') {
        setAlignKey(false);
      }
    };
    const release = () => setAlignKey(false);
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
    const hovered = hover ? (items[hover.index] ?? null) : null;
    const shown = placement ? [] : items;
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
      const fractionToCanvas = ([fx, fy]: ImagePoint): ImagePoint => [drawX + fx * drawWidth, drawY + fy * drawHeight];
      const pinLine = (from: ImagePoint, to: ImagePoint) => {
        ctx.beginPath();
        ctx.moveTo(from[0], from[1]);
        ctx.lineTo(to[0], to[1]);
        ctx.setLineDash([5 * px, 4 * px]);
        ctx.lineWidth = 2 * px;
        ctx.strokeStyle = '#0d6efd';
        ctx.stroke();
        ctx.setLineDash([]);
      };
      pins.forEach((pin, number) => {
        const from = normalizedToCanvas(pin.source, transform);
        const [tx, ty] = fractionToCanvas(pin.target);
        pinLine(from, [tx, ty]);
        ctx.beginPath();
        ctx.moveTo(tx - 10 * px, ty);
        ctx.lineTo(tx + 10 * px, ty);
        ctx.moveTo(tx, ty - 10 * px);
        ctx.lineTo(tx, ty + 10 * px);
        ctx.lineWidth = 2.5 * px;
        ctx.strokeStyle = '#0d6efd';
        ctx.stroke();
        drawLabel(String(number + 1), tx + 8 * px, ty - 10 * px, '#0d6efd', 13);
      });
      if (alignDrag) {
        const from = normalizedToCanvas(alignDrag.source, transform);
        pinLine(from, alignDrag.at);
        ctx.beginPath();
        ctx.arc(alignDrag.at[0], alignDrag.at[1], 7 * px, 0, Math.PI * 2);
        ctx.fillStyle = items[alignDrag.index]?.color ?? '#0d6efd';
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
    referencePoint,
    calibrationPoints,
    image,
    items,
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

  useEffect(() => {
    if (sourceMeta) {
      setPointOffsetX(sourceMeta.offset_x ?? 0);
      setPointOffsetY(sourceMeta.offset_y ?? 0);
      setPointScaleX(sourceMeta.scale_x ?? 1);
      setPointScaleY(sourceMeta.scale_y ?? 1);
      setIsVerticallyFlipped(sourceMeta.flip_y ?? true);
      setReferencePoint(
        sourceMeta.reference_x != null && sourceMeta.reference_y != null
          ? [sourceMeta.reference_x, sourceMeta.reference_y]
          : null,
      );
      setMetersPerPixel(
        sourceMeta.meters_per_pixel ? String(sourceMeta.meters_per_pixel) : '',
      );
      setCalibrationPoints([]);
      setCalibrationMeters('');
      setTool('pan');
    }
  }, [sourceMeta]);

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
      // Released off the canvas: the "Align" drag is dropped (on it, the
      // canvas pins it first - see handleCanvasMouseUp).
      setAlignDrag(null);
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
    event: React.MouseEvent<HTMLCanvasElement>,
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
    for (const [index, item] of items.entries()) {
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

  /** "Align": the sensor under the mouse and the grabbed point on it
   * (normalized - on a dm line where it was grabbed), or null. */
  const grabAt = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const index = itemAt(event);
    const transform = pointTransform();
    const at = canvasPointAt(event);
    if (index === null || !transform || !at) {
      return null;
    }
    const item = items[index];
    if (!item.end) {
      return { index, source: item.start, at };
    }
    const [ax, ay] = normalizedToCanvas(item.start, transform);
    const [bx, by] = normalizedToCanvas(item.end, transform);
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

  // The point calibration ends with "Store alignment" or "Cancel" (restore).
  const stopAligning = (restore: boolean) => {
    if (restore && alignBefore) {
      setPointOffsetX(alignBefore.offsetX);
      setPointOffsetY(alignBefore.offsetY);
      setPointScaleX(alignBefore.scaleX);
      setPointScaleY(alignBefore.scaleY);
      setIsVerticallyFlipped(alignBefore.flipY);
    }
    setAlignBefore(null);
    setPins([]);
    setAlignDrag(null);
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
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
    // A held: a press on a sensor drags it to its place (elsewhere it pans);
    // the first one remembers the alignment before, for "Cancel".
    if (alignKey && canAlign && tool === 'pan') {
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
    if (placement && tool === 'pan') {
      const sensor = sensorAt(event);
      if (sensor) {
        sensorDragRef.current = sensor.deviceId;
        placement.onSelect(sensor.deviceId);
        return;
      }
      pressRef.current = { x: event.clientX, y: event.clientY };
    }
    if (tool !== 'pan') {
      const point = imagePointAt(event);
      if (!point) {
        return;
      }
      if (tool === 'reference') {
        setReferencePoint(point);
        setTool('pan');
      } else {
        // A third click starts a new measurement.
        setCalibrationPoints((current) =>
          current.length >= 2 ? [point] : [...current, point],
        );
      }
      return;
    }
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startOffsetX: offsetX,
      startOffsetY: offsetY,
    };
  };

  const storeAlignment = (flipY: boolean) => {
    const values = {
      offsetX: pointOffsetX,
      offsetY: pointOffsetY,
      scaleX: pointScaleX,
      scaleY: pointScaleY,
      flipY,
    };
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

  return (
    <div className="d-flex flex-column gap-3">
      <div className="d-flex justify-content-between align-items-baseline gap-2 flex-wrap">
        <span style={{ fontSize: 14, fontWeight: 500 }}>{title}</span>
        {fileName && (
          <span style={{ fontSize: 12, color: MUTED }}>{fileName}</span>
        )}
      </div>

      <div className="d-flex flex-column gap-2">
        <div style={{ position: 'relative' }}>
          <canvas
            ref={canvasRef}
            width={Math.round(CANVAS_WIDTH * pixelRatio)}
            height={Math.round(CANVAS_HEIGHT * pixelRatio)}
            onMouseDown={handleMouseDown}
            onMouseUp={handleCanvasMouseUp}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHover(null)}
            onClick={handleClick}
            style={{
              display: 'block',
              width: '100%',
              height: 'auto',
              aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}`,
              borderRadius: 13,
              background: 'var(--progeo-surface)',
              boxShadow: 'inset 0 0 0 1px rgba(11, 54, 89, 0.08)',
              cursor:
                tool !== 'pan' || placement?.activeDeviceId != null
                  ? 'crosshair'
                  : dragRef.current || alignDrag
                    ? 'grabbing'
                    : alignKey && canAlign
                      ? hoveredItem
                        ? 'grab'
                        : 'crosshair'
                    : hoveredItem
                      ? 'pointer'
                      : 'grab',
            }}
          />
          <ZoomControls
            onZoomIn={() => zoomAround(ZOOM_STEP)}
            onZoomOut={() => zoomAround(1 / ZOOM_STEP)}
            onReset={resetView}
            zoomOutDisabled={zoom <= MIN_ZOOM}
            resetDisabled={zoom === 1 && offsetX === 0 && offsetY === 0}
          />
          <WheelZoomHint visible={wheelHint} />
          {alignKey && canAlign && (
            <div
              aria-live="polite"
              style={{
                position: 'absolute',
                top: 10,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 2,
                pointerEvents: 'none',
                background: '#0d6efd',
                color: '#ffffff',
                borderRadius: 'var(--progeo-radius-pill)',
                padding: '5px 14px',
                fontSize: 12.5,
                fontWeight: 600,
                boxShadow: '0 2px 8px rgba(11, 54, 89, .25)',
                whiteSpace: 'nowrap',
              }}
            >
              Align: drag a {lineMode ? 'dm line' : 'sensor'} onto its right place
            </div>
          )}
          {hover && hoveredItem && (
            <div
              role="tooltip"
              style={{
                position: 'absolute',
                left: clamp(hover.x + 14, 4, Math.max(4, cssWidth - 244)),
                top: tooltipBelow ? hover.y + 16 : hover.y - 16,
                transform: tooltipBelow ? undefined : 'translateY(-100%)',
                pointerEvents: 'none',
                zIndex: 2,
                minWidth: 150,
                maxWidth: 240,
                background: 'rgba(16, 20, 25, 0.93)',
                color: '#ffffff',
                borderRadius: 10,
                padding: '8px 11px',
                fontSize: 12,
                lineHeight: 1.5,
                boxShadow: '0 6px 18px rgba(0, 0, 0, 0.25)',
              }}
            >
              <div className="d-flex align-items-center gap-2" style={{ fontWeight: 600, fontSize: 13 }}>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: hoveredItem.color,
                  }}
                />
                {lineMode ? `dm ${hoveredItem.label}` : `Sensor ${hoveredItem.label}`}
              </div>
              {tooltipRows(hoveredItem).map(([label, value]) => (
                <div key={label} className="d-flex gap-2">
                  <span style={{ color: '#aab4be' }}>{label}</span>
                  <span className="ms-auto text-end">{value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          className="d-flex justify-content-between align-items-center gap-2 flex-wrap"
          style={{ fontSize: 12, color: MUTED, padding: '0 2px' }}
        >
          <span>Zoom {zoom.toFixed(2)}×</span>
          {!placement && items.length > 1 && (
            <span className="d-flex align-items-center gap-2">
              <span>{lineMode ? `dm ${items[0].label}` : items[0].label}</span>
              <span
                aria-hidden="true"
                style={{ width: 120, height: 8, borderRadius: 4, background: RAINBOW_GRADIENT }}
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
          <span>
            {placement
              ? placement.activeDeviceId != null
                ? `Click on the plan to place ${placement.activeLabel ?? 'the selected sensor'} · drag points to move them`
                : 'Select a sensor in step 3 · drag points to move them'
              : `Drag to pan · Ctrl + scroll or the buttons to zoom · hover a sensor for details${canAlign ? ' · hold A + drag a sensor to align' : ''}`}
          </span>
        </div>

        {!placement && lineSensors && items.length > 0 && lineCount === 0 && (
          <div
            style={{
              background: '#FBF3DE',
              color: '#9A7208',
              borderRadius: 12,
              padding: '10px 14px',
              fontSize: 12.5,
            }}
          >
            This is a smartex dm project, but these measure points have no band
            ends - import the DWG/DXF again in step 3 to get the sensor lines.
          </div>
        )}
      </div>

      {imageError && (
        <div
          style={{
            background: '#FBE9E3',
            color: '#C44D26',
            borderRadius: 12,
            padding: '10px 14px',
            fontSize: 12.5,
          }}
        >
          {imageError}
        </div>
      )}

      {withSliders && (
        <div style={SUB_PANEL}>
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 500 }}>Alignment</div>
              <div style={{ fontSize: 12, color: MUTED }}>
                Moves and scales the measure points onto the plan.
              </div>
            </div>
            <div className="ms-auto d-flex gap-2">
              <button
                type="button"
                className={`btn btn-sm ${isVerticallyFlipped ? 'btn-secondary' : 'btn-outline-secondary'}`}
                style={PILL_BUTTON}
                aria-pressed={isVerticallyFlipped}
                onClick={() => {
                  setIsVerticallyFlipped((current) => !current);
                  storeAlignment(!isVerticallyFlipped);
                }}
              >
                Vertical flip
              </button>
              {onSaveSliders && !aligning && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  style={PILL_BUTTON}
                  onClick={() => storeAlignment(isVerticallyFlipped)}
                >
                  Store alignment
                </button>
              )}
            </div>
          </div>

          {canAlign && !aligning && (
            <div className="d-flex align-items-center gap-2" style={{ fontSize: 12.5, color: MUTED }}>
              <kbd style={KEY_BADGE}>A</kbd>
              <span>
                Hold <strong>A</strong> and drag a {lineMode ? 'dm line' : 'sensor'} onto its right place on
                the plan - two far apart (e.g. opposite corners) set the alignment, more refine it.
              </span>
            </div>
          )}

          {aligning && (
            <div
              className="d-flex flex-wrap align-items-center gap-2"
              style={{
                background: '#E7F0FD',
                color: '#0B3659',
                borderRadius: 12,
                padding: '10px 14px',
                fontSize: 12.5,
              }}
            >
              <div style={{ flex: '1 1 260px' }}>
                <div style={{ fontWeight: 600 }}>
                  {pins.length} {lineMode ? 'dm sensor(s)' : 'sensor(s)'} pinned
                </div>
                <div>
                  {alignProblem && pins.length >= ALIGN_PINS
                    ? alignProblem
                    : alignError != null
                      ? `Computed from the pins - off by at most ${alignError.toFixed(1)} px of the plan. Hold A and drag more to refine, or store it.`
                      : `Hold A and drag one more ${lineMode ? 'dm line' : 'sensor'} onto its place, far from the first. Dragging one again moves its pin.`}
                </div>
              </div>
              <button type="button" className="btn btn-sm btn-outline-secondary" style={PILL_BUTTON} onClick={() => stopAligning(true)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                style={PILL_BUTTON}
                disabled={alignError == null}
                onClick={() => {
                  stopAligning(false);
                  storeAlignment(isVerticallyFlipped);
                }}
              >
                Store alignment
              </button>
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: '10px 24px',
            }}
          >
            {sliders.map((slider) => (
              <div key={slider.id}>
                <label
                  htmlFor={slider.id}
                  className="d-flex justify-content-between mb-0"
                  style={{ fontSize: 12, color: MUTED }}
                >
                  <span>{slider.label}</span>
                  <span
                    className="font-monospace"
                    style={{ color: 'var(--progeo-blue)' }}
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
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {withSliders && onSaveScale && (
        <div style={SUB_PANEL}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 500 }}>Scale</div>
            <div style={{ fontSize: 12, color: MUTED }}>
              Positions in meters: x to the right, y up from the reference
              point.
            </div>
          </div>

          <div className="d-flex flex-wrap align-items-center gap-2">
            <button
              type="button"
              className={`btn btn-sm ${tool === 'reference' ? 'btn-primary' : 'btn-outline-primary'}`}
              style={PILL_BUTTON}
              onClick={() =>
                setTool((current) =>
                  current === 'reference' ? 'pan' : 'reference',
                )
              }
            >
              Reference point
            </button>
            <span style={{ fontSize: 12, color: MUTED }}>
              {tool === 'reference'
                ? 'Click the reference point on the plan.'
                : referencePoint
                  ? `at pixel (${Math.round(referencePoint[0])}, ${Math.round(referencePoint[1])})`
                  : 'not set'}
            </span>
          </div>

          <div className="d-flex flex-wrap align-items-center gap-2">
            <button
              type="button"
              className={`btn btn-sm ${tool === 'calibrate' ? 'btn-primary' : 'btn-outline-primary'}`}
              style={PILL_BUTTON}
              onClick={() => {
                setTool((current) =>
                  current === 'calibrate' ? 'pan' : 'calibrate',
                );
                setCalibrationPoints([]);
              }}
            >
              Calibrate
            </button>
            {tool === 'calibrate' && calibrationPixels == null && (
              <span style={{ fontSize: 12, color: MUTED }}>
                Click two points with a known distance (
                {calibrationPoints.length}/2).
              </span>
            )}
            {calibrationPixels != null && (
              <>
                <span style={{ fontSize: 12, color: MUTED }}>
                  {calibrationPixels.toFixed(1)} px =
                </span>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  style={{ ...FIELD, width: 110 }}
                  min="0"
                  step="0.01"
                  placeholder="meters"
                  aria-label="Distance in meters"
                  value={calibrationMeters}
                  onChange={(event) => setCalibrationMeters(event.target.value)}
                />
                <span style={{ fontSize: 12, color: MUTED }}>m</span>
              </>
            )}
          </div>

          <div className="d-flex flex-wrap align-items-center gap-2">
            <label
              className="mb-0"
              htmlFor="meters-per-pixel"
              style={{ fontSize: 12, color: MUTED }}
            >
              Meters per pixel
            </label>
            <input
              id="meters-per-pixel"
              type="number"
              className="form-control form-control-sm"
              style={{ ...FIELD, width: 160 }}
              min="0"
              step="any"
              value={metersPerPixel}
              onChange={(event) => setMetersPerPixel(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-sm btn-primary ms-auto"
              style={PILL_BUTTON}
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
