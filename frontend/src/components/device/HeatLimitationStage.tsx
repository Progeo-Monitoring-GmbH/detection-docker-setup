import { useLayoutEffect, useMemo, useState } from 'react';
import { Button, Spinner } from 'react-bootstrap';
import { Magic } from 'react-bootstrap-icons';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
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
const PROPOSAL_COLOR = plotTheme.brandBlue;

/** An area proposed by heat-limitations/detect/: a building outline on the
 * plan, or around sensors outside every outline (cluster). */
type ProposedArea = Pick<HeatLimitation, 'name' | 'points'> & { sensors: number; kind: 'outline' | 'cluster' };
type Proposal = { areas: ProposedArea[]; sensors: number; clustered: number };

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
  areas: Array<Pick<HeatLimitation, 'points'>>,
  sensors: Segment[],
  /** Proposed areas: outlined (dashed) with their name. */
  outlined: Array<Pick<HeatLimitation, 'name' | 'points'>> = [],
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
  const polygons = limitPolygons(areas as HeatLimitation[], world);
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

  ctx.save();
  ctx.strokeStyle = PROPOSAL_COLOR;
  ctx.fillStyle = PROPOSAL_COLOR;
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 4]);
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  outlined.forEach(({ name, points }) => {
    ctx.beginPath();
    points.forEach(([x, y], index) => {
      const [sx, sy] = toScreen(view, x * world.width, y * world.height);
      if (index === 0) {
        ctx.moveTo(sx, sy);
      } else {
        ctx.lineTo(sx, sy);
      }
    });
    ctx.closePath();
    ctx.stroke();
    const [cx, cy] = toScreen(
      view,
      (points.reduce((sum, [x]) => sum + x, 0) / points.length) * world.width,
      (points.reduce((sum, [, y]) => sum + y, 0) / points.length) * world.height,
    );
    ctx.fillText(name, cx, cy);
  });
  ctx.restore();

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

  // Auto heat limitations: the areas proposed for this plan (shown instead
  // of the stored ones until applied or discarded).
  const auth = useAuth();
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const detect = () => {
    setDetecting(true);
    setDetectError('');
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${plan.location_id}/heat-limitations/detect/`,
      { lageplan_id: plan.id },
      (response) => {
        setDetecting(false);
        setProposal((response?.data ?? { areas: [], sensors: 0, clustered: 0 }) as Proposal);
      },
      (error) => {
        setDetecting(false);
        const reason = (error as { response?: { data?: { reason?: string } } })?.response?.data?.reason;
        setDetectError(reason || 'The heat limitations could not be detected');
      },
    );
  };
  const apply = async () => {
    if (proposal && (await editor.replaceAreas(proposal.areas))) {
      setProposal(null);
    }
  };
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
      drawStage(
        ctx,
        { width, height: canvasHeight, dpr },
        view,
        image,
        world,
        proposal ? proposal.areas : editor.shownAreas,
        sensors,
        proposal?.areas,
      );
    }
  }, [canvasRef, image, world, view, width, canvasHeight, editor.shownAreas, sensors, proposal]);

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
      {proposal ? (
        <ProposalBar
          proposal={proposal}
          existing={editor.areas.length}
          busy={editor.busy}
          onApply={() => void apply()}
          onDiscard={() => setProposal(null)}
          testId={childTestId(testId, 'proposal')}
        />
      ) : (
        <div className="mb-2 d-flex flex-wrap align-items-center gap-2">
          {editor.canEdit && !drawing && (
            <Button
              size="sm"
              className="image-canvas-pill image-canvas-auto"
              onClick={detect}
              disabled={detecting || editor.busy}
              title="Find the outlines of the buildings with sensors on the plan"
              data-testid={childTestId(testId, 'auto-detect')}
            >
              {detecting ? <Spinner size="sm" animation="border" className="me-1" /> : <Magic className="me-1" />}
              Auto-detect
            </Button>
          )}
          <HeatLimitationBar editor={editor} testId={childTestId(testId, 'heat-limit')} />
        </div>
      )}
      {detectError && (
        <div className="text-danger small mb-2" data-testid={childTestId(testId, 'detect-error')}>
          {detectError}
        </div>
      )}
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
          {view && !proposal && (
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

/** The proposed areas: what was found, Apply (replacing the stored areas) or Discard. */
const ProposalBar = ({
  proposal,
  existing,
  busy,
  onApply,
  onDiscard,
  testId,
}: {
  proposal: Proposal;
  existing: number;
  busy: boolean;
  onApply: () => void;
  onDiscard: () => void;
  testId?: string;
}) => {
  const outlines = proposal.areas.filter((area) => area.kind === 'outline').length;
  const clusters = proposal.areas.length - outlines;
  return (
    <div
      className="image-canvas-action image-canvas-action--align d-flex flex-wrap align-items-center gap-2 mb-2"
      data-testid={testId}
    >
      <div className="image-canvas-action-text">
        {proposal.areas.length === 0 ? (
          <div className="image-canvas-action-title">No areas found</div>
        ) : (
          <>
            <div className="image-canvas-action-title">
              {proposal.areas.length} area(s) found - dashed on the plan
            </div>
            {outlines} building outline(s) with sensors
            {clusters > 0 && `, ${clusters} around ${proposal.clustered} sensor(s) outside every outline`}. Every
            area holds at least one sensor.
            {existing > 0 && ` Apply replaces the ${existing} stored area(s).`}
          </>
        )}
      </div>
      {proposal.areas.length > 0 && (
        <Button size="sm" variant="primary" onClick={onApply} disabled={busy} data-testid={childTestId(testId, 'apply')}>
          {busy && <Spinner size="sm" animation="border" className="me-1" />}
          Apply
        </Button>
      )}
      <Button
        size="sm"
        variant="outline-secondary"
        onClick={onDiscard}
        disabled={busy}
        data-testid={childTestId(testId, 'discard')}
      >
        Discard
      </Button>
    </div>
  );
};

export default HeatLimitationStage;
