import {
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, Button, Card, Col, Container, Row } from 'react-bootstrap';
import RedDropbox from '../components/form/RedDropbox.tsx';
import { useAuth } from '../../hooks/CoreAuthProvider';

type FactoryPoint = {
  pos: number;
  x: number;
  y: number;
  nx: number;
  ny: number;
};

const DOT_CANVAS_WIDTH = 360;
const DOT_CANVAS_HEIGHT = 260;
const POS_CANVAS_WIDTH = 560;
const POS_CANVAS_HEIGHT = 360;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 12;

type ViewTransform = {
  zoom: number;
  offsetX: number;
  offsetY: number;
};

type CanvasKey = 'normalized' | 'position';

type DrawPoint = {
  pos: number;
  px: number;
  py: number;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const getLineColorFromPos = (pos: number, minPos: number, maxPos: number) => {
  if (maxPos <= minPos) {
    return 'hsl(20, 90%, 45%)';
  }
  const t = clamp((pos - minPos) / (maxPos - minPos), 0, 1);
  const hue = Math.round(220 - 220 * t);
  return `hsl(${hue}, 88%, 46%)`;
};

const normalizePoints = (
  rawPoints: Array<{ pos: number; x: number; y: number }>,
): FactoryPoint[] => {
  if (!rawPoints.length) {
    return [];
  }

  const xs = rawPoints.map((point) => point.x);
  const ys = rawPoints.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);

  return rawPoints.map((point) => ({
    ...point,
    nx: clamp((point.x - minX) / spanX, 0, 1),
    ny: 1 - clamp((point.y - minY) / spanY, 0, 1),
  }));
};

const parsePoints = (raw: unknown): FactoryPoint[] => {
  if (!Array.isArray(raw)) {
    throw new Error('JSON must contain an array of points.');
  }

  const parsed = raw
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const candidate = item as Record<string, unknown>;
      const pos = Number(candidate.pos);
      const x = Number(candidate.x);
      const y = Number(candidate.y);
      const nx = Number(candidate.nx);
      const ny = Number(candidate.ny);

      if ([pos, x, y].some((value) => Number.isNaN(value))) {
        return null;
      }

      const hasNormalized = ![nx, ny].some((value) => Number.isNaN(value));
      return {
        pos,
        x,
        y,
        nx,
        ny,
        hasNormalized,
      };
    })
    .filter(
      (
        point,
      ): point is {
        pos: number;
        x: number;
        y: number;
        nx: number;
        ny: number;
        hasNormalized: boolean;
      } => !!point,
    );

  const needsNormalization = parsed.some((point) => !point.hasNormalized);

  if (!needsNormalization) {
    return parsed.map(({ pos, x, y, nx, ny }) => ({ pos, x, y, nx, ny }));
  }

  return normalizePoints(
    parsed.map((point) => ({
      pos: point.pos,
      x: point.x,
      y: point.y,
    })),
  );
};

const parseSemicolonPointsText = (text: string): FactoryPoint[] => {
  const rawPoints: Array<{ pos: number; x: number; y: number }> = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  lines.forEach((line, idx) => {
    const parts = line.split(';').map((part) => part.trim());
    if (parts.length < 7) {
      return;
    }

    const x = Number(parts[5]);
    const y = Number(parts[6]);
    const posFromNo = Number(parts[0]);
    const fallbackPos = idx + 1;
    const pos = Number.isNaN(posFromNo) ? fallbackPos : posFromNo;

    if (Number.isNaN(x) || Number.isNaN(y)) {
      return;
    }

    rawPoints.push({ pos, x, y });
  });

  return normalizePoints(rawPoints);
};

const FactoryVisualizerView = () => {
  const auth = useAuth();
  const [points, setPoints] = useState<FactoryPoint[]>([]);
  const [sourceName, setSourceName] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [normalizedView, setNormalizedView] = useState<ViewTransform>({
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  });
  const [positionView, setPositionView] = useState<ViewTransform>({
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  });
  const [draggingCanvas, setDraggingCanvas] = useState<CanvasKey | null>(null);

  const normalizedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const positionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{
    key: CanvasKey;
    startX: number;
    startY: number;
    startOffsetX: number;
    startOffsetY: number;
  } | null>(null);

  const orderedPoints = useMemo(
    () => [...points].sort((a, b) => a.pos - b.pos),
    [points],
  );

  const posRange = useMemo(() => {
    if (!orderedPoints.length) {
      return { minPos: 0, maxPos: 1 };
    }
    return {
      minPos: orderedPoints[0].pos,
      maxPos: orderedPoints[orderedPoints.length - 1].pos,
    };
  }, [orderedPoints]);

  const normalizedDrawPoints = useMemo<DrawPoint[]>(
    () =>
      orderedPoints.map((point) => ({
        pos: point.pos,
        px: clamp(point.nx, 0, 1) * (DOT_CANVAS_WIDTH - 1),
        py: clamp(point.ny, 0, 1) * (DOT_CANVAS_HEIGHT - 1),
      })),
    [orderedPoints],
  );

  const positionDrawPoints = useMemo<DrawPoint[]>(() => {
    if (!orderedPoints.length) {
      return [];
    }

    const xs = orderedPoints.map((point) => point.x);
    const ys = orderedPoints.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const pad = 18;
    const drawWidth = POS_CANVAS_WIDTH - pad * 2;
    const drawHeight = POS_CANVAS_HEIGHT - pad * 2;

    return orderedPoints.map((point) => ({
      pos: point.pos,
      px: pad + ((point.x - minX) / spanX) * drawWidth,
      py: pad + ((maxY - point.y) / spanY) * drawHeight,
    }));
  }, [orderedPoints]);

  const getCanvasInfo = (
    canvas: HTMLCanvasElement,
    event: WheelEvent | MouseEvent,
  ) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;
    return { x, y };
  };

  const getView = (key: CanvasKey) =>
    key === 'normalized' ? normalizedView : positionView;

  const setView = (key: CanvasKey, next: ViewTransform) => {
    if (key === 'normalized') {
      setNormalizedView(next);
      return;
    }
    setPositionView(next);
  };

  const resetViews = () => {
    setNormalizedView({ zoom: 1, offsetX: 0, offsetY: 0 });
    setPositionView({ zoom: 1, offsetX: 0, offsetY: 0 });
  };

  const handleCanvasWheel = (
    key: CanvasKey,
    event: ReactWheelEvent<HTMLCanvasElement>,
  ) => {
    event.preventDefault();
    const canvas =
      key === 'normalized'
        ? normalizedCanvasRef.current
        : positionCanvasRef.current;
    if (!canvas) {
      return;
    }

    const { x, y } = getCanvasInfo(canvas, event.nativeEvent);
    const current = getView(key);
    const factor = event.deltaY < 0 ? 1.14 : 1 / 1.14;
    const nextZoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const worldX = (x - current.offsetX) / current.zoom;
    const worldY = (y - current.offsetY) / current.zoom;
    const next: ViewTransform = {
      zoom: nextZoom,
      offsetX: x - worldX * nextZoom,
      offsetY: y - worldY * nextZoom,
    };
    setView(key, next);
  };

  const handleCanvasMouseDown = (
    key: CanvasKey,
    event: ReactMouseEvent<HTMLCanvasElement>,
  ) => {
    const current = getView(key);
    dragRef.current = {
      key,
      startX: event.clientX,
      startY: event.clientY,
      startOffsetX: current.offsetX,
      startOffsetY: current.offsetY,
    };
    setDraggingCanvas(key);
  };

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      setView(drag.key, {
        ...getView(drag.key),
        offsetX: drag.startOffsetX + dx,
        offsetY: drag.startOffsetY + dy,
      });
    };

    const onMouseUp = () => {
      dragRef.current = null;
      setDraggingCanvas(null);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [normalizedView, positionView]);

  const summary = useMemo(() => {
    if (!points.length) {
      return null;
    }

    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);

    return {
      count: points.length,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  }, [points]);

  useEffect(() => {
    const canvas = normalizedCanvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fcfcfc';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = '#cfd4da';
    ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);

    ctx.save();
    ctx.setTransform(
      normalizedView.zoom,
      0,
      0,
      normalizedView.zoom,
      normalizedView.offsetX,
      normalizedView.offsetY,
    );

    for (let i = 1; i < normalizedDrawPoints.length; i += 1) {
      const prev = normalizedDrawPoints[i - 1];
      const curr = normalizedDrawPoints[i];
      ctx.strokeStyle = getLineColorFromPos(
        curr.pos,
        posRange.minPos,
        posRange.maxPos,
      );
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(prev.px, prev.py);
      ctx.lineTo(curr.px, curr.py);
      ctx.stroke();
    }

    normalizedDrawPoints.forEach((point) => {
      ctx.fillStyle = getLineColorFromPos(
        point.pos,
        posRange.minPos,
        posRange.maxPos,
      );
      ctx.beginPath();
      ctx.arc(point.px, point.py, 2.4, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.restore();
  }, [normalizedDrawPoints, normalizedView, posRange.maxPos, posRange.minPos]);

  useEffect(() => {
    const canvas = positionCanvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fcfcfc';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#cfd4da';
    ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);

    if (!positionDrawPoints.length) {
      return;
    }

    ctx.save();
    ctx.setTransform(
      positionView.zoom,
      0,
      0,
      positionView.zoom,
      positionView.offsetX,
      positionView.offsetY,
    );

    for (let i = 1; i < positionDrawPoints.length; i += 1) {
      const prev = positionDrawPoints[i - 1];
      const curr = positionDrawPoints[i];
      ctx.strokeStyle = getLineColorFromPos(
        curr.pos,
        posRange.minPos,
        posRange.maxPos,
      );
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(prev.px, prev.py);
      ctx.lineTo(curr.px, curr.py);
      ctx.stroke();
    }

    ctx.font = '10px monospace';
    positionDrawPoints.forEach((point) => {
      const color = getLineColorFromPos(
        point.pos,
        posRange.minPos,
        posRange.maxPos,
      );
      ctx.fillStyle = color;
      ctx.fillRect(point.px - 1.2, point.py - 1.2, 2.4, 2.4);
      ctx.fillText(String(point.pos), point.px + 4, point.py - 4);
    });

    ctx.restore();
  }, [positionDrawPoints, positionView, posRange.maxPos, posRange.minPos]);

  const handleImportedData = async (payload: FormData) => {
    setError('');

    const firstFile = payload.get('files0');
    if (!(firstFile instanceof File)) {
      setPoints([]);
      setSourceName('');
      setError('No file found in upload payload.');
      return;
    }

    const loweredName = firstFile.name.toLowerCase();
    if (!loweredName.endsWith('.json') && !loweredName.endsWith('.txt')) {
      setPoints([]);
      setSourceName(firstFile.name);
      setError('Only .json and .txt files are supported in this visualizer.');
      return;
    }

    try {
      const text = await firstFile.text();
      let parsedPoints: FactoryPoint[] = [];

      if (loweredName.endsWith('.txt')) {
        parsedPoints = parseSemicolonPointsText(text);
      } else {
        const parsed = JSON.parse(text);
        parsedPoints = parsePoints(parsed);
      }

      if (!parsedPoints.length) {
        setPoints([]);
        setSourceName(firstFile.name);
        setError('No valid points found in file.');
        return;
      }

      setPoints(parsedPoints);
      setSourceName(firstFile.name);
      resetViews();
    } catch (exc) {
      setPoints([]);
      setSourceName(firstFile.name);
      setError(
        `Could not parse file. Expected JSON array or semicolon TXT lines: ${(exc as Error).message}`,
      );
    }
  };

  return (
    <Container className="py-4">
      <Row className="mb-3">
        <Col>
          <Card>
            <Card.Body>
              <Card.Title>Factory Visualizer</Card.Title>
              <Card.Text className="text-muted mb-0">
                Import a JSON or TXT file with points and inspect normalized
                pixels (nx/ny) and position labels (pos at x/y).
              </Card.Text>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      <Row className="mb-4">
        <Col>
          <Card>
            <Card.Header>Import JSON/TXT</Card.Header>
            <Card.Body>
              <RedDropbox
                auth={auth}
                url="/v1/status/measure_points/upload_cad/"
                accept="doc"
                withPreview={false}
                instantFileUpload={false}
                callBackProcessing={handleImportedData}
              />

              <div className="d-flex gap-2 mt-2">
                <Button
                  variant="outline-secondary"
                  onClick={() => {
                    setPoints([]);
                    setSourceName('');
                    setError('');
                    resetViews();
                  }}
                >
                  Clear
                </Button>
                <Button
                  variant="outline-secondary"
                  onClick={() => resetViews()}
                >
                  Reset View
                </Button>
                {sourceName && (
                  <div className="text-muted align-self-center">
                    Loaded: {sourceName}
                  </div>
                )}
              </div>

              {error && (
                <Alert variant="danger" className="mt-3 mb-0">
                  {error}
                </Alert>
              )}
            </Card.Body>
          </Card>
        </Col>
      </Row>

      <Row className="g-3">
        <Col lg={5}>
          <Card>
            <Card.Header>Pixels at nx/ny</Card.Header>
            <Card.Body>
              <canvas
                ref={normalizedCanvasRef}
                width={DOT_CANVAS_WIDTH}
                height={DOT_CANVAS_HEIGHT}
                onWheel={(event) => handleCanvasWheel('normalized', event)}
                onMouseDown={(event) =>
                  handleCanvasMouseDown('normalized', event)
                }
                style={{
                  width: '100%',
                  maxWidth: DOT_CANVAS_WIDTH,
                  height: 'auto',
                  cursor: draggingCanvas === 'normalized' ? 'grabbing' : 'grab',
                }}
              />
            </Card.Body>
          </Card>
        </Col>

        <Col lg={7}>
          <Card>
            <Card.Header>pos labels at x/y</Card.Header>
            <Card.Body>
              <canvas
                ref={positionCanvasRef}
                width={POS_CANVAS_WIDTH}
                height={POS_CANVAS_HEIGHT}
                onWheel={(event) => handleCanvasWheel('position', event)}
                onMouseDown={(event) =>
                  handleCanvasMouseDown('position', event)
                }
                style={{
                  width: '100%',
                  maxWidth: POS_CANVAS_WIDTH,
                  height: 'auto',
                  cursor: draggingCanvas === 'position' ? 'grabbing' : 'grab',
                }}
              />
            </Card.Body>
          </Card>
        </Col>
      </Row>

      {summary && (
        <Row className="mt-3">
          <Col>
            <Card>
              <Card.Body className="text-muted">
                Points: {summary.count} | x-range: {summary.minX}..
                {summary.maxX} | y-range: {summary.minY}..{summary.maxY} | Mouse
                wheel: zoom | Drag: pan
              </Card.Body>
            </Card>
          </Col>
        </Row>
      )}
    </Container>
  );
};

export default FactoryVisualizerView;
