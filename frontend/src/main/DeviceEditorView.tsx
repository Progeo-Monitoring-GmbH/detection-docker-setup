import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Button, Card, Container, Form } from 'react-bootstrap';
import { ArrowLeft, CloudArrowUp, Floppy, PlusCircle } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';

type CanvasPoint = {
  id: number;
  x: number;
  y: number;
};

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const POINT_SIZE = 20;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const DeviceEditorView = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);

  const [points, setPoints] = useState<CanvasPoint[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [mousePos, setMousePos] = useState({ x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 });
  const [isStoring, setIsStoring] = useState(false);

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

    const scale = Math.min(CANVAS_WIDTH / bgImage.width, CANVAS_HEIGHT / bgImage.height);
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
          x: clamp(Number(point.x) * CANVAS_WIDTH, 0, CANVAS_WIDTH),
          y: clamp(Number(point.y) * CANVAS_HEIGHT, 0, CANVAS_HEIGHT),
        }));
        setPoints(loaded);
      },
      (error) => {
        showErrorBar(enqueueSnackbar, `Could not load points: ${error.message}`);
      },
    );
  };

  useEffect(() => {
    drawCanvas();
  }, []);

  useEffect(() => {
    loadPoints();
  }, [id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'a') {
        return;
      }
      setPoints((prev) => ([
        ...prev,
        {
          id: prev.length + 1,
          x: clamp(mousePos.x, 0, CANVAS_WIDTH),
          y: clamp(mousePos.y, 0, CANVAS_HEIGHT),
        },
      ]));
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mousePos]);

  const getCanvasCoordinates = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return { x: 0, y: 0 };
    }

    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp(clientX - rect.left, 0, CANVAS_WIDTH),
      y: clamp(clientY - rect.top, 0, CANVAS_HEIGHT),
    };
  };

  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getCanvasCoordinates(event.clientX, event.clientY);
    setPoints((prev) => ([...prev, { id: prev.length + 1, x, y }]));
  };

  const handleCanvasMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getCanvasCoordinates(event.clientX, event.clientY);
    setMousePos({ x, y });

    if (dragIndex === null) {
      return;
    }

    setPoints((prev) => prev.map((point, idx) => (
      idx === dragIndex
        ? {
            ...point,
            x: clamp(x, POINT_SIZE / 2, CANVAS_WIDTH - POINT_SIZE / 2),
            y: clamp(y, POINT_SIZE / 2, CANVAS_HEIGHT - POINT_SIZE / 2),
          }
        : point
    )));
  };

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
        setPoints(stored.map((point: any, index: number) => ({
          id: index + 1,
          x: clamp(Number(point.x) * CANVAS_WIDTH, 0, CANVAS_WIDTH),
          y: clamp(Number(point.y) * CANVAS_HEIGHT, 0, CANVAS_HEIGHT),
        })));
        setIsStoring(false);
        showSuccessBar(enqueueSnackbar, `Stored ${stored.length} point(s)`);
      },
      (error) => {
        setIsStoring(false);
        showErrorBar(enqueueSnackbar, `Could not store points: ${error.message}`);
      },
    );
  };

  return (
    <Container className="py-4">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <Button variant="outline-secondary" onClick={() => navigate(`/device/${id}/update`)}>
          <ArrowLeft className="me-2" />
          Back to Device
        </Button>
        <div className="d-flex gap-2">
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
            <Form.Control type="file" accept="image/png" onChange={loadBackground} />
          </Form.Group>
          <div className="text-muted">
            <CloudArrowUp className="me-1" />
            Canvas {CANVAS_WIDTH}x{CANVAS_HEIGHT} | Press <strong>A</strong> to add point at mouse position
          </div>
          <div className="text-muted ms-auto">
            <PlusCircle className="me-1" />
            Next point id: {nextPointId}
          </div>
        </Card.Header>
        <Card.Body>
          <div
            style={{
              width: CANVAS_WIDTH,
              height: CANVAS_HEIGHT,
              position: 'relative',
              border: '1px solid #ced4da',
              borderRadius: 8,
              overflow: 'hidden',
              margin: '0 auto',
              maxWidth: '100%',
            }}
          >
            <canvas
              ref={canvasRef}
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              style={{ display: 'block', cursor: 'crosshair', width: '100%', height: '100%' }}
              onClick={handleCanvasClick}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={() => setDragIndex(null)}
              onMouseLeave={() => setDragIndex(null)}
            />

            {points.map((point, index) => (
              <div
                key={point.id}
                role="button"
                tabIndex={0}
                onMouseDown={(event) => {
                  event.stopPropagation();
                  setDragIndex(index);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    setDragIndex(index);
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
                  backgroundColor: '#dc3545',
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'grab',
                  userSelect: 'none',
                  border: '1px solid #ffffff',
                  boxShadow: '0 1px 6px rgba(0, 0, 0, 0.35)',
                }}
                title={`Point ${point.id}`}
              >
                {point.id}
              </div>
            ))}
          </div>
        </Card.Body>
      </Card>
    </Container>
  );
};

export default DeviceEditorView;
