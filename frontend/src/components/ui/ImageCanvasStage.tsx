import { useEffect, useRef, useState } from 'react';
import axiosConfig from '../../axiosConfig';
import { useAuth } from '../../../hooks/CoreAuthProvider';

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

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
  }) => void;
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

  useEffect(() => {
    if (!imageUrl) {
      setImage(null);
      return;
    }

    const nextImage = new Image();
    nextImage.onload = () => setImage(nextImage);
    nextImage.onerror = () => setImage(null);
    nextImage.src = imageUrl;
  }, [imageUrl]);

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

    const baseScale = Math.min(
      (width - 32) / image.naturalWidth,
      (height - 32) / image.naturalHeight,
      1.5,
    );
    const drawWidth = image.naturalWidth * baseScale * zoom;
    const drawHeight = image.naturalHeight * baseScale * zoom;
    const drawX = width / 2 - drawWidth / 2 + offsetX;
    const drawY = height / 2 - drawHeight / 2 + offsetY;

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
        drawX + pointOffsetX + normalizedX * drawWidth * pointScaleX;
      const pointY =
        drawY + pointOffsetY + normalizedY * drawHeight * pointScaleY;
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
  }, [
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
    }
  }, [sourceMeta]);

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

  const handleMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
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
        width={900}
        height={600}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        style={{
          width: '100%',
          height: 'auto',
          border: '1px solid #dfe3e8',
          borderRadius: 8,
          background: '#f5f6f8',
          cursor: dragRef.current ? 'grabbing' : 'grab',
        }}
      />

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
                  })
                }
              >
                Store alignment
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ImageCanvasStage;
