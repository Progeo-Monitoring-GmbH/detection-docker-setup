import { useEffect, useRef, useState } from 'react';
import axiosConfig from '../../axiosConfig';
import { useAuth } from '../../../hooks/CoreAuthProvider';

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const CANVAS_WIDTH = 900;
const CANVAS_HEIGHT = 600;
const CANVAS_PADDING = 32;

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
export type SensorPlacement = {
  sensors: PlacedSensor[];
  activeDeviceId: number | null;
  activeLabel?: string;
  onPlace: (nx: number, ny: number) => void;
  onMove: (deviceId: number, nx: number, ny: number) => void;
  onSelect: (deviceId: number) => void;
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
    sourceMeta?.flip_y ?? false,
  );
  const [tool, setTool] = useState<CanvasTool>('pan');
  const [referencePoint, setReferencePoint] = useState<ImagePoint | null>(null);
  const [calibrationPoints, setCalibrationPoints] = useState<ImagePoint[]>([]);
  const [calibrationMeters, setCalibrationMeters] = useState('');
  const [metersPerPixel, setMetersPerPixel] = useState('');

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

    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#f5f6f8';
    ctx.fillRect(0, 0, width, height);

    const layout = canvasLayout(canvas, image, zoom, offsetX, offsetY);
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
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
    ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);

    // Sensors placed by hand: numbered dots with their label (MAC) beside.
    placement?.sensors.forEach((sensor, index) => {
      const [pointX, pointY] = normalizedToCanvas(
        [sensor.nx, sensor.ny],
        transform,
      );
      const active = sensor.deviceId === placement.activeDeviceId;

      ctx.beginPath();
      ctx.arc(pointX, pointY, SENSOR_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = active ? '#0d6efd' : '#198754';
      ctx.fill();
      ctx.lineWidth = active ? 3 : 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      ctx.font = '600 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(index + 1), pointX, pointY);

      ctx.font = '600 12px sans-serif';
      ctx.textAlign = 'left';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.strokeText(sensor.label, pointX + SENSOR_RADIUS + 4, pointY);
      ctx.fillStyle = active ? '#0d6efd' : '#212529';
      ctx.fillText(sensor.label, pointX + SENSOR_RADIUS + 4, pointY);
    });

    (placement ? [] : measurePoints).forEach((point, index) => {
      const normalizedX = Number(point.nx);
      const normalizedY = Number(point.ny);
      if (!Number.isFinite(normalizedX) || !Number.isFinite(normalizedY)) {
        return;
      }

      const [pointX, pointY] = normalizedToCanvas(
        [normalizedX, normalizedY],
        transform,
      );
      const radius = 7;
      const label = String(point.pos ?? point.sensor_order ?? index + 1);

      ctx.beginPath();
      ctx.arc(pointX, pointY, radius, 0, Math.PI * 2);
      ctx.fillStyle = '#dc3545';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      ctx.font = '600 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, pointX, pointY);
    });

    // Calibration: the two picked points and the line between them.
    if (calibrationPoints.length) {
      const [first, second] = calibrationPoints.map(toCanvas);
      ctx.strokeStyle = '#fd7e14';
      ctx.fillStyle = '#fd7e14';
      ctx.lineWidth = 2;
      if (second) {
        ctx.beginPath();
        ctx.moveTo(first[0], first[1]);
        ctx.lineTo(second[0], second[1]);
        ctx.stroke();
      }
      [first, second].filter(Boolean).forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // Reference point (origin of the positions in meters): a crosshair.
    if (referencePoint) {
      const [x, y] = toCanvas(referencePoint);
      ctx.strokeStyle = '#0d6efd';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 12, y);
      ctx.lineTo(x + 12, y);
      ctx.moveTo(x, y - 12);
      ctx.lineTo(x, y + 12);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [
    referencePoint,
    calibrationPoints,
    image,
    measurePoints,
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
    console.log('sourceMeta changed:', sourceMeta);
    if (sourceMeta) {
      setPointOffsetX(sourceMeta.offset_x ?? 0);
      setPointOffsetY(sourceMeta.offset_y ?? 0);
      setPointScaleX(sourceMeta.scale_x ?? 1);
      setPointScaleY(sourceMeta.scale_y ?? 1);
      setIsVerticallyFlipped(sourceMeta.flip_y ?? false);
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

      const dx = event.clientX - dragRef.current.startX;
      const dy = event.clientY - dragRef.current.startY;
      setOffsetX(dragRef.current.startOffsetX + dx);
      setOffsetY(dragRef.current.startOffsetY + dy);
    };

    const handleMouseUp = () => {
      dragRef.current = null;
      sensorDragRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const nextZoom = clamp(
      zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12),
      0.4,
      10,
    );

    const nextOffsetX =
      offsetX + (pointerX - canvas.width / 2) * (1 - nextZoom / zoom);
    const nextOffsetY =
      offsetY + (pointerY - canvas.height / 2) * (1 - nextZoom / zoom);

    setZoom(nextZoom);
    setOffsetX(nextOffsetX);
    setOffsetY(nextOffsetY);
  };

  /** Canvas pixel under the mouse (the canvas is scaled by CSS, width: 100%). */
  const canvasPointAt = (
    event: React.MouseEvent<HTMLCanvasElement>,
  ): ImagePoint | null => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) * canvas.width) / rect.width,
      ((event.clientY - rect.top) * canvas.height) / rect.height,
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
      canvas,
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
      ...canvasLayout(canvas, image, zoom, offsetX, offsetY),
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
          SENSOR_RADIUS + 3
        );
      }) ?? null
    );
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
    {
      id: 'point-scale-x',
      label: 'Scale X',
      value: pointScaleX,
      display: pointScaleX.toFixed(2),
      min: 0.1,
      max: 5,
      step: 0.01,
      onChange: setPointScaleX,
    },
    {
      id: 'point-scale-y',
      label: 'Scale Y',
      value: pointScaleY,
      display: pointScaleY.toFixed(2),
      min: 0.1,
      max: 5,
      step: 0.01,
      onChange: setPointScaleY,
    },
  ];

  return (
    <div className="d-flex flex-column gap-3">
      <div className="d-flex justify-content-between align-items-baseline gap-2 flex-wrap">
        <span style={{ fontSize: 14, fontWeight: 500 }}>{title}</span>
        {fileName && (
          <span style={{ fontSize: 12, color: MUTED }}>{fileName}</span>
        )}
      </div>

      <div className="d-flex flex-column gap-2">
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleSensorMouseMove}
          onClick={handleClick}
          style={{
            display: 'block',
            width: '100%',
            height: 'auto',
            borderRadius: 13,
            background: 'var(--progeo-surface)',
            boxShadow: 'inset 0 0 0 1px rgba(11, 54, 89, 0.08)',
            cursor:
              tool !== 'pan' || placement?.activeDeviceId != null
                ? 'crosshair'
                : dragRef.current
                  ? 'grabbing'
                  : 'grab',
          }}
        />

        <div
          className="d-flex justify-content-between align-items-center gap-2 flex-wrap"
          style={{ fontSize: 12, color: MUTED, padding: '0 2px' }}
        >
          <span>Zoom {zoom.toFixed(2)}×</span>
          <span>
            {placement
              ? placement.activeDeviceId != null
                ? `Click on the plan to place ${placement.activeLabel ?? 'the selected sensor'} · drag points to move them`
                : 'Select a sensor in step 3 · drag points to move them'
              : 'Drag to pan · scroll to zoom'}
          </span>
        </div>
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
              {onSaveSliders && (
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
                  min={slider.min}
                  max={slider.max}
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
