import { useLayoutEffect, useMemo } from 'react';
import { Spinner } from 'react-bootstrap';
import { getBackendUrl } from '../../backendUrl';
import { plotTheme } from '../../styles/plotTheme';
import { childTestId } from '../../testIds';
import { normalizedToImage } from '../ui/ImageCanvasStage';
import { TWO_FINGER_TOUCH_ACTION, useWheelHint, WheelZoomHint } from '../ui/wheelZoom';
import { toScreen, toWorld, type View, type WorldSize } from './heatmapCanvas';
import { sizedContext } from './heatmapScene';
import { HeatLimitationBar, HeatLimitationLayer, useHeatLimitationEditor } from './HeatLimitationEditor';
import { limitPolygons, toPlanPoint } from './heatLimitations';
import type { HeatLimitation, SensorHeatmapLageplanData } from './sensorHeatmapTypes';
import { useHeatmapViewport, usePanZoomGestures } from './useHeatmapViewport';
import { useLageplanImageState } from './useLageplanImage';
import ZoomControls from './ZoomControls';
import './SensorHeatmap2D.css';

const ZOOM_STEP = 1.4;
/** The plan outside every area: dimmed - the heat field is cut off there. */
const OUTSIDE_SHADE = 'rgba(33, 37, 41, 0.35)';
const SENSOR_COLOR = plotTheme.brandOrange;

type Segment = { start: [number, number]; end: [number, number] | null };

const finite = (value: unknown) => (value == null || value === '' ? NaN : Number(value));

/** The measure points in world coordinates (image pixels), placed by the
 * plan's point alignment like everywhere else - dm bands as lines. */
const sensorSegments = (
  points: Array<Record<string, unknown>>,
  plan: SensorHeatmapLageplanData,
  world: WorldSize,
): Segment[] => {
  const alignment = {
    offsetX: plan.offset_x ?? 0,
    offsetY: plan.offset_y ?? 0,
    scaleX: plan.scale_x ?? 1,
    scaleY: plan.scale_y ?? 1,
    flipY: plan.flip_y ?? true,
  };
  const place = (nx: number, ny: number) => normalizedToImage([nx, ny], alignment, world.width, world.height);
  return points.flatMap((point) => {
    const [nx, ny, ex, ey] = [point.nx, point.ny, point.nx_end, point.ny_end].map(finite);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
      return [];
    }
    return [{ start: place(nx, ny), end: Number.isFinite(ex) && Number.isFinite(ey) ? place(ex, ey) : null }];
  });
};

const drawStage = (
  ctx: CanvasRenderingContext2D,
  size: { width: number; height: number; dpr: number },
  view: View,
  image: HTMLImageElement,
  world: WorldSize,
  areas: HeatLimitation[],
  sensors: Segment[],
) => {
  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size.width, size.height);

  const drawPlan = () => {
    ctx.save();
    ctx.translate(view.tx, view.ty);
    ctx.scale(view.scale, view.scale);
    ctx.drawImage(image, 0, 0, world.width, world.height);
    ctx.restore();
  };
  drawPlan();

  // Outside the areas the plan is dimmed: shade it all, then draw the plan
  // again clipped to the areas (nonzero - overlapping areas add up).
  const polygons = limitPolygons(areas, world);
  if (polygons.length) {
    const [x0, y0] = toScreen(view, 0, 0);
    const [x1, y1] = toScreen(view, world.width, world.height);
    ctx.fillStyle = OUTSIDE_SHADE;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.save();
    ctx.beginPath();
    polygons.forEach((polygon) => {
      polygon.forEach(([wx, wy], index) => {
        const [sx, sy] = toScreen(view, wx, wy);
        if (index === 0) {
          ctx.moveTo(sx, sy);
        } else {
          ctx.lineTo(sx, sy);
        }
      });
      ctx.closePath();
    });
    ctx.clip('nonzero');
    drawPlan();
    ctx.restore();
  }

  // The sensors - where the heat comes from.
  ctx.strokeStyle = SENSOR_COLOR;
  ctx.fillStyle = SENSOR_COLOR;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  sensors.forEach(({ start, end }) => {
    const [sx, sy] = toScreen(view, ...start);
    if (end) {
      const [ex, ey] = toScreen(view, ...end);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(sx, sy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  });
};

/**
 * The heat limitations of one Lageplan, edited on the plan image (Lageplan
 * wizard, staff and superusers): the bar to create, copy, edit and delete
 * areas (HeatLimitationBar) over the plan with its sensors, the areas and
 * the draft (HeatLimitationLayer). Outside the areas the plan is dimmed, as
 * the heatmap cuts its heat field off there. Ctrl + wheel zooms, drag moves,
 * while drawing every click adds a point.
 */
const HeatLimitationStage = ({
  plan,
  plans,
  points,
  editable,
  onChange,
  height = 560,
  testId = 'heat-limit-stage',
}: {
  plan: SensorHeatmapLageplanData & { id: number };
  /** Every plan of the location (the editor keeps saved lists per plan list). */
  plans: SensorHeatmapLageplanData[];
  /** The plan's measure points (nx/ny, dm: also nx_end/ny_end) - for orientation. */
  points: Array<Record<string, unknown>>;
  /** Whether the user may edit (staff or superuser). */
  editable: boolean;
  /** A plan's new list after every save. */
  onChange?: (planId: number, areas: HeatLimitation[]) => void;
  height?: number;
  testId?: string;
}) => {
  const { image, pending } = useLageplanImageState(plan.url ? getBackendUrl(plan.url) : null);
  const world = useMemo<WorldSize | null>(
    () => (image ? { width: image.naturalWidth, height: image.naturalHeight } : null),
    [image],
  );
  const editor = useHeatLimitationEditor({ plans, plan, editable: editable && image != null, onChange });
  const drawing = editor.draft != null;
  const sensors = useMemo(() => (world ? sensorSegments(points, plan, world) : []), [points, plan, world]);

  const bounds = useMemo(
    () => (world ? { left: 0, top: 0, right: world.width, bottom: world.height } : null),
    [world],
  );
  const { wrapRef, width, canvasHeight, view, isZoomed, setView, zoomBy } = useHeatmapViewport({
    bounds,
    height,
    fitPlan: true,
    compact: false,
  });

  const [wheelHint, showWheelHint] = useWheelHint();
  const { canvasRef, grabbing, handlers } = usePanZoomGestures({
    enabled: image != null,
    view,
    setView,
    zoomBy,
    onHover: () => undefined,
    onLeave: () => undefined,
    onTap: (sx, sy) => {
      if (drawing && view && world) {
        editor.addPoint(toPlanPoint(toWorld(view, sx, sy), world), world);
      }
    },
    wheelZoomsAt: (sx, sy) => {
      if (!view || !world) {
        return false;
      }
      const [wx, wy] = toWorld(view, sx, sy);
      return wx >= 0 && wy >= 0 && wx <= world.width && wy <= world.height;
    },
    onPlainWheel: showWheelHint,
    oneFingerPans: drawing,
    onOneFingerTouch: () => showWheelHint('touch'),
  });

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || !world || !view || width <= 0) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const ctx = sizedContext(canvas, width, canvasHeight, dpr);
    if (ctx) {
      drawStage(ctx, { width, height: canvasHeight, dpr }, view, image, world, editor.shownAreas, sensors);
    }
  }, [canvasRef, image, world, view, width, canvasHeight, editor.shownAreas, sensors]);

  if (pending) {
    return (
      <div
        className="d-flex justify-content-center align-items-center text-muted"
        style={{ minHeight: height }}
        data-testid={childTestId(testId, 'loading')}
      >
        <Spinner animation="border" size="sm" className="me-2" />
        Loading plan…
      </div>
    );
  }
  if (!image || !world) {
    return (
      <div className="text-muted small py-3" data-testid={childTestId(testId, 'no-image')}>
        The plan image could not be loaded - heat limitations are drawn on it.
      </div>
    );
  }

  return (
    <div data-testid={testId}>
      <div className="mb-2">
        <HeatLimitationBar editor={editor} testId={childTestId(testId, 'heat-limit')} />
      </div>
      <div ref={wrapRef} className="heatmap2d-plot-area">
        <div
          className="heatmap2d-plot-wrap"
          data-testid={childTestId(testId, 'plot')}
          style={{ height: canvasHeight, width: width > 0 ? width : undefined }}
        >
          <canvas
            ref={canvasRef}
            role="img"
            aria-label="Lageplan with its heat limitations"
            data-testid={childTestId(testId, 'canvas')}
            className={`heatmap2d-canvas heatmap2d-canvas--${drawing ? 'crosshair' : grabbing ? 'grabbing' : 'grab'}`}
            style={{ height: canvasHeight, touchAction: drawing ? 'none' : TWO_FINGER_TOUCH_ACTION }}
            {...handlers}
            // While drawing, double clicks are two points - not a reset.
            onDoubleClick={() => !drawing && setView(null)}
          />
          {view && (
            <HeatLimitationLayer
              editor={editor}
              view={view}
              world={world}
              width={width}
              height={canvasHeight}
              testId={childTestId(testId, 'heat-limit')}
            />
          )}
          <WheelZoomHint visible={wheelHint} radius={0} testId={childTestId(testId, 'wheel-hint')} />
          <ZoomControls
            onZoomIn={() => zoomBy(ZOOM_STEP)}
            onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
            onReset={() => setView(null)}
            resetDisabled={!isZoomed}
            testId={childTestId(testId, 'zoom')}
          />
        </div>
      </div>
    </div>
  );
};

export default HeatLimitationStage;
