import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Button, Card, Container, Form } from 'react-bootstrap';
import {
  ArrowLeft,
  CloudArrowUp,
  Floppy,
  PlusCircle,
} from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import RedDropbox from '../components/form/RedDropbox.tsx';

type CanvasPoint = {
  id: number;
  x: number;
  y: number;
  grid_x: number;
  grid_y: number;
  reference?: boolean;
};

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 1000;
const POINT_SIZE = 20;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const DeviceEditorView = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasWrapperRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const wasDraggingRef = useRef(false);
  const wasPanningRef = useRef(false);
  const suppressNextCanvasClickRef = useRef(false);
  const panStartRef = useRef<{
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);

  const [points, setPoints] = useState<CanvasPoint[]>([]);
  const [dragPointId, setDragPointId] = useState<number | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [isAddMode, setIsAddMode] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isStoring, setIsStoring] = useState(false);

  const markReferencePoint = (items: CanvasPoint[]) => {
    if (!items.length) {
      return items;
    }

    const explicit = items.find((point) => point.reference);
    if (explicit) {
      return items;
    }

    const candidate = items.reduce(
      (best, point) => {
        if (!best) {
          return point;
        }
        if (point.x < best.x || (point.x === best.x && point.y < best.y)) {
          return point;
        }
        return best;
      },
      null as CanvasPoint | null,
    );

    if (!candidate) {
      return items;
    }

    return items.map((point) => ({
      ...point,
      reference: point.id === candidate.id,
    }));
  };

  const nextPointId = useMemo(() => points.length + 1, [points.length]);

  const drawCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.fillStyle = '#f8f9fa';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    const bgImage = bgImageRef.current;
    if (!bgImage) {
      return;
    }

    const scale = Math.min(
      CANVAS_WIDTH / bgImage.width,
      CANVAS_HEIGHT / bgImage.height,
    );
    const drawWidth = bgImage.width * scale;
    const drawHeight = bgImage.height * scale;
    const offsetX = (CANVAS_WIDTH - drawWidth) / 2;
    const offsetY = (CANVAS_HEIGHT - drawHeight) / 2;

    ctx.drawImage(bgImage, offsetX, offsetY, drawWidth, drawHeight);
  };

  const loadPoints = () => {
    if (!id) {
      return;
    }

    void axiosConfig.perform_get(
      auth,
      `/v1/status/measure_points/?device_id=${encodeURIComponent(id)}`,
      (response) => {
        const data = response?.data || {};
        const incoming = Array.isArray(data.points) ? data.points : [];
        const loaded = incoming.map((point: any, index: number) => ({
          id: index + 1,
          x: clamp(point.nx * CANVAS_WIDTH, 0, CANVAS_WIDTH),
          y: clamp(point.ny * CANVAS_HEIGHT, 0, CANVAS_HEIGHT),
          reference: !!point.reference,
        }));
        setPoints(markReferencePoint(loaded));
      },
      (error) => {
        showErrorBar(
          enqueueSnackbar,
          `Could not load points: ${error.message}`,
        );
      },
    );
  };

  useEffect(() => {
    drawCanvas();
  }, []);

  useEffect(() => {
    loadPoints();
  }, [id]);

  const getCanvasCoordinates = (clientX: number, clientY: number) => {
    const wrapper = canvasWrapperRef.current;
    if (!wrapper) {
      return { x: 0, y: 0 };
    }

    const rect = wrapper.getBoundingClientRect();
    const relativeX = clientX - rect.left;
    const relativeY = clientY - rect.top;

    const contentX = (relativeX - pan.x) / zoom;
    const contentY = (relativeY - pan.y) / zoom;

    const scaleX = rect.width > 0 ? CANVAS_WIDTH / rect.width : 1;
    const scaleY = rect.height > 0 ? CANVAS_HEIGHT / rect.height : 1;
    return {
      x: clamp(contentX * scaleX, 0, CANVAS_WIDTH),
      y: clamp(contentY * scaleY, 0, CANVAS_HEIGHT),
    };
  };

  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (suppressNextCanvasClickRef.current) {
      suppressNextCanvasClickRef.current = false;
      return;
    }

    if (!isAddMode) {
      return;
    }

    const { x, y } = getCanvasCoordinates(event.clientX, event.clientY);
    setPoints((prev) => [...prev, { id: prev.length + 1, x, y }]);
  };

  const handleCanvasMouseDown = (
    event: React.MouseEvent<HTMLCanvasElement>,
  ) => {
    if (event.button !== 0 || isAddMode) {
      return;
    }
    event.preventDefault();
    panStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    wasPanningRef.current = false;
    setIsPanning(true);
  };

  const handleCanvasWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();

    const wrapper = canvasWrapperRef.current;
    if (!wrapper) {
      return;
    }

    const rect = wrapper.getBoundingClientRect();
    const relativeX = event.clientX - rect.left;
    const relativeY = event.clientY - rect.top;
    const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9;
    const nextZoom = clamp(zoom * zoomFactor, MIN_ZOOM, MAX_ZOOM);
    const worldX = (relativeX - pan.x) / zoom;
    const worldY = (relativeY - pan.y) / zoom;

    setZoom(nextZoom);
    setPan({
      x: relativeX - worldX * nextZoom,
      y: relativeY - worldY * nextZoom,
    });
  };

  useEffect(() => {
    if (dragPointId === null) {
      return;
    }

    const onMouseMove = (event: MouseEvent) => {
      const { x, y } = getCanvasCoordinates(event.clientX, event.clientY);
      wasDraggingRef.current = true;

      setPoints((prev) =>
        prev.map((point) =>
          point.id === dragPointId
            ? {
                ...point,
                x: clamp(x, POINT_SIZE / 2, CANVAS_WIDTH - POINT_SIZE / 2),
                y: clamp(y, POINT_SIZE / 2, CANVAS_HEIGHT - POINT_SIZE / 2),
              }
            : point,
        ),
      );
    };

    const onMouseUp = () => {
      if (wasDraggingRef.current) {
        suppressNextCanvasClickRef.current = true;
      }
      setDragPointId(null);
      wasDraggingRef.current = false;
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [dragPointId]);

  useEffect(() => {
    if (!isPanning) {
      return;
    }

    const onMouseMove = (event: MouseEvent) => {
      const start = panStartRef.current;
      if (!start) {
        return;
      }
      const nextPanX = start.panX + (event.clientX - start.x);
      const nextPanY = start.panY + (event.clientY - start.y);
      setPan({ x: nextPanX, y: nextPanY });
      wasPanningRef.current = true;
    };

    const onMouseUp = () => {
      if (wasPanningRef.current) {
        suppressNextCanvasClickRef.current = true;
      }
      setIsPanning(false);
      wasPanningRef.current = false;
      panStartRef.current = null;
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isPanning]);

  const loadBackground = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (file.type !== 'image/png') {
      showErrorBar(enqueueSnackbar, 'Only PNG files are supported');
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      bgImageRef.current = img;
      drawCanvas();
      URL.revokeObjectURL(objectUrl);
    };
    img.onerror = () => {
      showErrorBar(enqueueSnackbar, 'Could not load selected image');
      URL.revokeObjectURL(objectUrl);
    };
    img.src = objectUrl;
  };

  const handleStore = () => {
    if (!id) {
      return;
    }

    setIsStoring(true);
    const payload = {
      device_id: Number(id),
      points: points.map((point, index) => ({
        sensor_order: index + 1,
        x: Number((point.x / CANVAS_WIDTH).toFixed(6)),
        y: Number((point.y / CANVAS_HEIGHT).toFixed(6)),
      })),
    };

    void axiosConfig.perform_post(
      auth,
      '/v1/status/measure_points/',
      payload,
      (response) => {
        const data = response?.data || {};
        const stored = Array.isArray(data.points) ? data.points : [];
        const loaded = stored.map((point: any, index: number) => ({
          id: index + 1,
          x: clamp(point.nx * CANVAS_WIDTH, 0, CANVAS_WIDTH),
          y: clamp(point.ny * CANVAS_HEIGHT, 0, CANVAS_HEIGHT),
          reference: !!point.reference,
        }));
        setPoints(markReferencePoint(loaded));
        setIsStoring(false);
        showSuccessBar(enqueueSnackbar, `Stored ${stored.length} point(s)`);
      },
      (error) => {
        setIsStoring(false);
        showErrorBar(
          enqueueSnackbar,
          `Could not store points: ${error.message}`,
        );
      },
    );
  };

  return (
    <Container className="py-4">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <Button
          variant="outline-secondary"
          onClick={() => navigate(`/device/${id}/update`)}
        >
          <ArrowLeft className="me-2" />
          Back to Device
        </Button>
        <div className="d-flex gap-2">
          <Button
            variant={isAddMode ? 'success' : 'outline-success'}
            onClick={() => setIsAddMode((prev) => !prev)}
          >
            <PlusCircle className="me-2" />
            {isAddMode ? 'Add-Mode On' : 'Add-Mode Off'}
          </Button>
          <Button variant="outline-dark" onClick={() => setPoints([])}>
            Clear
          </Button>
          <Button variant="primary" onClick={handleStore} disabled={isStoring}>
            <Floppy className="me-2" />
            {isStoring ? 'Storing...' : 'Store'}
          </Button>
        </div>
      </div>

      <Card>
        <Card.Header className="d-flex flex-wrap gap-3 align-items-center">
          <Form.Group className="mb-0">
            <Form.Label className="mb-1">Background PNG</Form.Label>
            <Form.Control
              type="file"
              accept="image/png"
              onChange={loadBackground}
            />
          </Form.Group>
          <div className="text-muted">
            <CloudArrowUp className="me-1" />
            Canvas {CANVAS_WIDTH}x{CANVAS_HEIGHT} | Wheel: zoom | Drag
            background: pan
          </div>
          <div className="text-muted ms-auto">
            <PlusCircle className="me-1" />
            Next point id: {nextPointId}
          </div>
        </Card.Header>
        <Card.Body>
          <RedDropbox
            auth={auth}
            url={`/v1/status/measure_points/upload_cad/?device_id=${encodeURIComponent(String(id || ''))}`}
            accept="cad"
            maxSizeMB={150}
            withPreview={false}
            instantFileUpload={true}
            callBackProcessing={(data) => {
              const incoming = Array.isArray(data?.points) ? data.points : [];
              const loaded = incoming.map((point: any, index: number) => ({
                id: index + 1,
                x: clamp(Number(point.x) * CANVAS_WIDTH, 0, CANVAS_WIDTH),
                y: clamp(Number(point.y) * CANVAS_HEIGHT, 0, CANVAS_HEIGHT),
                reference: !!point.reference,
              }));
              setPoints(markReferencePoint(loaded));
              showSuccessBar(
                enqueueSnackbar,
                `Imported ${loaded.length} point(s) from CAD`,
              );
            }}
          />

          <div
            ref={canvasWrapperRef}
            onWheel={handleCanvasWheel}
            style={{
              width: CANVAS_WIDTH,
              height: CANVAS_HEIGHT,
              position: 'relative',
              border: '1px solid #ced4da',
              borderRadius: 8,
              overflow: 'hidden',
              margin: '0 auto',
              maxWidth: '100%',
              cursor: isPanning ? 'grabbing' : isAddMode ? 'crosshair' : 'grab',
            }}
          >
            <div
              ref={stageRef}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: CANVAS_WIDTH,
                height: CANVAS_HEIGHT,
                transformOrigin: '0 0',
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              }}
            >
              <canvas
                ref={canvasRef}
                width={CANVAS_WIDTH}
                height={CANVAS_HEIGHT}
                style={{
                  display: 'block',
                  width: CANVAS_WIDTH,
                  height: CANVAS_HEIGHT,
                }}
                onMouseDown={handleCanvasMouseDown}
                onClick={handleCanvasClick}
              />

              <svg
                width={CANVAS_WIDTH}
                height={CANVAS_HEIGHT}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  pointerEvents: 'none',
                }}
              >
                {points.slice(1).map((point, index) => {
                  const previous = points[index];
                  return (
                    <line
                      key={`line-${previous.id}-${point.id}`}
                      x1={previous.x}
                      y1={previous.y}
                      x2={point.x}
                      y2={point.y}
                      stroke="#0d6efd"
                      strokeWidth={2}
                      strokeOpacity={0.8}
                    />
                  );
                })}
              </svg>

              {points.map((point) => (
                <div
                  key={point.id}
                  role="button"
                  tabIndex={0}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    wasDraggingRef.current = false;
                    setDragPointId(point.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      setDragPointId(point.id);
                    }
                  }}
                  style={{
                    position: 'absolute',
                    left: point.x,
                    top: point.y,
                    width: POINT_SIZE,
                    height: POINT_SIZE,
                    transform: 'translate(-50%, -50%)',
                    borderRadius: '50%',
                    backgroundColor: point.reference ? '#198754' : '#dc3545',
                    color: '#fff',
                    fontSize: 11,
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: dragPointId === point.id ? 'grabbing' : 'grab',
                    userSelect: 'none',
                    border: '1px solid #ffffff',
                    boxShadow: '0 1px 6px rgba(0, 0, 0, 0.35)',
                  }}
                  title={`Point ${point.id} | (${point.grid_x}, ${point.grid_y})}`}
                >
                  {point.id}
                </div>
              ))}
            </div>
          </div>
        </Card.Body>
      </Card>
    </Container>
  );
};

export default DeviceEditorView;
