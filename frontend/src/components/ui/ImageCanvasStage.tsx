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
};

const ImageCanvasStage = ({
  imageUrl,
  sourceMeta,
  title = 'Image preview',
  fileName,
  measurePoints = [],
  withSliders = false,
  locationId,
  onSaveSliders,
  onSaveScale,
}: ImageCanvasStageProps) => {
  const auth = useAuth();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startOffsetX: number;
    startOffsetY: number;
  } | null>(null);

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

    const { scale, drawWidth, drawHeight, drawX, drawY } = canvasLayout(
      canvas,
      image,
      zoom,
      offsetX,
      offsetY,
    );
    const toCanvas = ([x, y]: ImagePoint): ImagePoint => [
      drawX + x * scale,
      drawY + y * scale,
    ];

    ctx.strokeStyle = '#cfd4da';
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
    ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);

    measurePoints.forEach((point, index) => {
      const normalizedX = Number(point.nx);
      const rawNormalizedY = Number(point.ny);
      if (!Number.isFinite(normalizedX) || !Number.isFinite(rawNormalizedY)) {
        return;
      }
      const normalizedY = isVerticallyFlipped
        ? 1 - rawNormalizedY
        : rawNormalizedY;

      const pointX =
        drawX + pointOffsetX * zoom + normalizedX * drawWidth * pointScaleX;
      const pointY =
        drawY + pointOffsetY * zoom + normalizedY * drawHeight * pointScaleY;
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

  /** Image pixel under the mouse, or null outside the plan. */
  const imagePointAt = (
    event: React.MouseEvent<HTMLCanvasElement>,
  ): ImagePoint | null => {
    const canvas = canvasRef.current;
    if (!canvas || !image) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    // The canvas is scaled by CSS (width: 100%).
    const canvasX = ((event.clientX - rect.left) * canvas.width) / rect.width;
    const canvasY = ((event.clientY - rect.top) * canvas.height) / rect.height;
    const { scale, drawX, drawY } = canvasLayout(
      canvas,
      image,
      zoom,
      offsetX,
      offsetY,
    );
    const x = (canvasX - drawX) / scale;
    const y = (canvasY - drawY) / scale;
    if (x < 0 || y < 0 || x > image.naturalWidth || y > image.naturalHeight) {
      return null;
    }
    return [x, y];
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
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

  return (
    <div className="d-flex flex-column gap-2">
      <div className="d-flex justify-content-between align-items-center">
        <strong>{title}</strong>
        {fileName && <small className="text-muted">{fileName}</small>}
      </div>

      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        style={{
          width: '100%',
          height: 'auto',
          border: '1px solid #dfe3e8',
          borderRadius: 8,
          background: '#f5f6f8',
          cursor:
            tool !== 'pan'
              ? 'crosshair'
              : dragRef.current
                ? 'grabbing'
                : 'grab',
        }}
      />

      {imageError && (
        <div className="alert alert-danger mb-0 py-2 small">{imageError}</div>
      )}

      <div className="d-flex justify-content-between align-items-center text-muted small">
        <span>Zoom: {zoom.toFixed(2)}x</span>
        <span>Drag to pan</span>
      </div>

      {withSliders && (
        <div className="row g-2">
          <div className="col-12">
            <button
              type="button"
              className={`btn ${isVerticallyFlipped ? 'btn-secondary' : 'btn-outline-secondary'}`}
              onClick={async () => {
                setIsVerticallyFlipped((current) => !current);
                await axiosConfig.perform_post(
                  auth,
                  '/v1/location/update/',
                  {
                    location_id: locationId,
                    offset_x: pointOffsetX,
                    offset_y: pointOffsetY,
                    scale_x: pointScaleX,
                    scale_y: pointScaleY,
                    flip_y: !isVerticallyFlipped,
                  },
                  () => {},
                  (saveError) => {},
                );
              }}
            >
              Vertical Flip
            </button>
          </div>
          <div className="col-md-6">
            <label className="form-label mb-0" htmlFor="point-offset-x">
              offsetX: {pointOffsetX}
            </label>
            <input
              id="point-offset-x"
              className="form-range"
              type="range"
              min="-250"
              max="250"
              step="1"
              value={pointOffsetX}
              onChange={(event) => setPointOffsetX(Number(event.target.value))}
            />
          </div>
          <div className="col-md-6">
            <label className="form-label mb-0" htmlFor="point-offset-y">
              offsetY: {pointOffsetY}
            </label>
            <input
              id="point-offset-y"
              className="form-range"
              type="range"
              min="-250"
              max="250"
              step="1"
              value={pointOffsetY}
              onChange={(event) => setPointOffsetY(Number(event.target.value))}
            />
          </div>
          <div className="col-md-6">
            <label className="form-label mb-0" htmlFor="point-scale-x">
              scaleX: {pointScaleX.toFixed(2)}
            </label>
            <input
              id="point-scale-x"
              className="form-range"
              type="range"
              min="0.1"
              max="5"
              step="0.01"
              value={pointScaleX}
              onChange={(event) => setPointScaleX(Number(event.target.value))}
            />
          </div>
          <div className="col-md-6">
            <label className="form-label mb-0" htmlFor="point-scale-y">
              scaleY: {pointScaleY.toFixed(2)}
            </label>
            <input
              id="point-scale-y"
              className="form-range"
              type="range"
              min="0.1"
              max="5"
              step="0.01"
              value={pointScaleY}
              onChange={(event) => setPointScaleY(Number(event.target.value))}
            />
          </div>
          {onSaveSliders && (
            <div className="col-12">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  onSaveSliders({
                    offsetX: pointOffsetX,
                    offsetY: pointOffsetY,
                    scaleX: pointScaleX,
                    scaleY: pointScaleY,
                    flipY: isVerticallyFlipped,
                  })
                }
              >
                Store alignment
              </button>
            </div>
          )}
        </div>
      )}

      {withSliders && onSaveScale && (
        <div className="border-top pt-2 d-flex flex-column gap-2">
          <strong className="small">
            Scale (positions in meters: x to the right, y up from the
            reference point)
          </strong>

          <div className="d-flex flex-wrap align-items-center gap-2">
            <button
              type="button"
              className={`btn btn-sm ${tool === 'reference' ? 'btn-primary' : 'btn-outline-primary'}`}
              onClick={() =>
                setTool((current) =>
                  current === 'reference' ? 'pan' : 'reference',
                )
              }
            >
              Reference point
            </button>
            <span className="small text-muted">
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
              className={`btn btn-sm ${tool === 'calibrate' ? 'btn-warning' : 'btn-outline-warning'}`}
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
              <span className="small text-muted">
                Click two points with a known distance (
                {calibrationPoints.length}/2).
              </span>
            )}
            {calibrationPixels != null && (
              <>
                <span className="small text-muted">
                  {calibrationPixels.toFixed(1)} px =
                </span>
                <input
                  type="number"
                  className="form-control form-control-sm"
                  style={{ width: 110 }}
                  min="0"
                  step="0.01"
                  placeholder="meters"
                  aria-label="Distance in meters"
                  value={calibrationMeters}
                  onChange={(event) => setCalibrationMeters(event.target.value)}
                />
                <span className="small text-muted">m</span>
              </>
            )}
          </div>

          <div className="d-flex flex-wrap align-items-center gap-2">
            <label className="small mb-0" htmlFor="meters-per-pixel">
              Meters per pixel
            </label>
            <input
              id="meters-per-pixel"
              type="number"
              className="form-control form-control-sm"
              style={{ width: 160 }}
              min="0"
              step="any"
              value={metersPerPixel}
              onChange={(event) => setMetersPerPixel(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-sm btn-primary"
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
