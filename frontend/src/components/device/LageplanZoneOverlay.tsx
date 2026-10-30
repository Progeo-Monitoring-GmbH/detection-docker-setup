import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { getBackendUrl } from '../../backendUrl';
import { alarmHeatColor } from '../../main/alarmUtils';
import CursorTooltip, { TooltipRow } from '../ui/CursorTooltip';
import { fullBox, isFull, panBox, type ViewBox, viewBoxAttribute, zoomBox } from './planViewBox';
import SensorTooltip from './SensorTooltip';
import ZoomControls from './ZoomControls';

export type LageplanZonePoint = {
  pos: number;
  /** Normalized position on the plan image (0..1, y downwards). */
  x: number;
  y: number;
  /** Sensor or zone name (ProgeoMeasurePoint.name). */
  name: string | null;
  /** Joins points into one line/segment; defaults to `name`. */
  group?: string | null;
  /** Label of that line/segment; defaults to `name`. */
  groupLabel?: string | null;
  value: number | null;
  threshold: number | null;
  /** Position in meters; null while the plan isn't calibrated. */
  meters?: [number, number] | null;
};

/**
 * - lines: the points of a group, in sensor order, joined by a line (one
 *   physical run of sensors) - smartex® dm.
 * - segments: one filled area per group around its sensors - smartex® is,
 *   mx-va, mx-al.
 * - points: every sensor a dot with its name - smartex® io, vt.
 */
export type LageplanOverlayMode = 'lines' | 'segments' | 'points';

type LageplanZoneOverlayProps = {
  imageUrl: string | null;
  points: LageplanZonePoint[];
  height?: number;
  mode?: LageplanOverlayMode;
};

type ZoneGroup = {
  key: string;
  label: string | null;
  points: LageplanZonePoint[];
  isOver: boolean;
  /** Highest current value of the group's sensors, with its threshold. */
  color: string;
};

type Hover = {
  cursorX: number;
  cursorY: number;
  width: number;
  height: number;
} & ({ kind: 'point'; point: LageplanZonePoint } | { kind: 'zone'; group: ZoneGroup });

/** Marker outline of a sensor (or segment) reading above its threshold - as on the heatmap. */
const OVER_THRESHOLD_COLOR = '#dc2626';
const SEGMENT_OPACITY = 0.55;
/** Zoom per button click; the wheel zooms continuously. */
const ZOOM_STEP = 1.5;
/** Pointer movement (px) after which a press is a drag, not a click. */
const DRAG_THRESHOLD = 3;

/**
 * Lageplan visualization of the Status tab for the products that don't show
 * the continuous Gaussian heat field of SensorHeatmap2D (see
 * planVisualization in main/projectType.ts). Every sensor, line and segment
 * is coloured on the heatmap's scale (alarmHeatColor); readings above the
 * threshold get a red outline. Hovering a sensor shows its values, hovering
 * a line or segment the group's.
 *
 * The plan image lies in the SVG with its own size (image pixels) as
 * coordinate system, so the points land exactly on it (a square viewBox
 * would squeeze them towards the middle of a wide plan). Zoom (wheel over
 * the plan, pinch, buttons) and drag change the viewBox - markers and lines
 * keep their size on screen. Double click resets.
 */
const LageplanZoneOverlay = ({ imageUrl, points, height = 480, mode = 'lines' }: LageplanZoneOverlayProps) => {
  const { t } = useTranslation();
  const groups = groupPoints(points, mode);

  const resolvedUrl = imageUrl ? getBackendUrl(imageUrl) : null;

  // Media files need the Authorization header, which a plain <img> can't send.
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  // Natural size of the plan image - the overlay's coordinate system.
  const [imageSize, setImageSize] = useState<[number, number] | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // The shown part of the plan; null: all of it.
  const [userBox, setUserBox] = useState<ViewBox | null>(null);
  // Pointers pressed on the plan (drag: one, pinch: two).
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    setImageSrc(null);
    setImageSize(null);
    if (!resolvedUrl) {
      return undefined;
    }
    let cancelled = false;
    void axiosConfig.perform_get(
      authRef.current,
      resolvedUrl,
      (response) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (!cancelled && typeof reader.result === 'string') {
            setImageSrc(reader.result);
          }
        };
        reader.readAsDataURL(response.data as Blob);
      },
      () => {
        // No plan image - the zones are still drawn without it.
      },
      { responseType: 'blob' },
    );
    return () => {
      cancelled = true;
    };
  }, [resolvedUrl]);

  useEffect(() => {
    setUserBox(null);
  }, [imageSize]);

  // Without the image (yet) the points span a square, as before.
  const [viewWidth, viewHeight] = imageSize ?? [1, 1];
  const full = fullBox(viewWidth, viewHeight);
  const box = userBox ?? full;
  // Plan geometry relative to the image's shorter side ...
  const planUnit = Math.min(viewWidth, viewHeight);
  // ... markers, lines and labels to the shown part's: same size on screen at any zoom.
  const unit = Math.min(box.w, box.h);
  const toView = (point: LageplanZonePoint): [number, number] => [point.x * viewWidth, point.y * viewHeight];

  // Screen -> plan coordinates (null where the browser can't tell, e.g. jsdom).
  const toPlan = (clientX: number, clientY: number) => {
    const matrix = svgRef.current?.getScreenCTM?.();
    if (!matrix) {
      return null;
    }
    const inverse = matrix.inverse();
    return {
      x: inverse.a * clientX + inverse.c * clientY + inverse.e,
      y: inverse.b * clientX + inverse.d * clientY + inverse.f,
      pixelsPerUnit: matrix.a,
    };
  };
  const onPlan = (x: number, y: number) => x >= 0 && y >= 0 && x <= viewWidth && y <= viewHeight;

  const zoomBy = (factor: number, clientX?: number, clientY?: number) => {
    const at = clientX != null && clientY != null ? toPlan(clientX, clientY) : null;
    setUserBox((current) => {
      const shown = current ?? full;
      const next = zoomBox(shown, factor, at?.x ?? shown.x + shown.w / 2, at?.y ?? shown.y + shown.h / 2, full);
      return isFull(next, full) ? null : next;
    });
  };
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;
  const toPlanRef = useRef(toPlan);
  toPlanRef.current = toPlan;
  const onPlanRef = useRef(onPlan);
  onPlanRef.current = onPlan;

  // Wheel zoom only over the plan image - elsewhere the page scrolls.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) {
      return undefined;
    }
    const onWheel = (event: WheelEvent) => {
      const at = toPlanRef.current(event.clientX, event.clientY);
      if (!at || !onPlanRef.current(at.x, at.y)) {
        return;
      }
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomByRef.current(Math.exp(-delta * 0.0015), event.clientX, event.clientY);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) {
      return;
    }
    const others = [...pointers.current.entries()].filter(([id]) => id !== event.pointerId);
    if (
      !dragging &&
      others.length === 0 &&
      Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < DRAG_THRESHOLD
    ) {
      return; // still a click - hovering keeps working
    }
    if (!dragging) {
      // Only now: a captured pointer would end the hover tooltips at once.
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setDragging(true);
      setHover(null);
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (others.length === 0) {
      const scale = toPlan(event.clientX, event.clientY)?.pixelsPerUnit;
      if (scale) {
        const dx = (event.clientX - previous.x) / scale;
        const dy = (event.clientY - previous.y) / scale;
        setUserBox((current) => (current ? panBox(current, dx, dy, full) : current));
      }
      return;
    }
    // Pinch: zoom by the change of the fingers' distance, around their middle.
    const [, other] = others[0];
    const before = Math.hypot(previous.x - other.x, previous.y - other.y);
    const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
    if (before > 0 && after > 0) {
      zoomBy(after / before, (event.clientX + other.x) / 2, (event.clientY + other.y) / 2);
    }
  };

  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (pointers.current.size === 0) {
      setDragging(false);
    }
  };

  const hoverAt = (event: MouseEvent, target: { point: LageplanZonePoint } | { group: ZoneGroup }) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || dragging) {
      return;
    }
    const position = {
      cursorX: event.clientX - rect.left,
      cursorY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    };
    setHover('point' in target
      ? { ...position, kind: 'point', point: target.point }
      : { ...position, kind: 'zone', group: target.group });
  };

  const groupHover = (group: ZoneGroup) => ({
    style: { cursor: 'pointer' },
    onMouseMove: (event: MouseEvent) => hoverAt(event, { group }),
    onMouseLeave: () => setHover(null),
  });

  // Half the typical sensor spacing: how far a segment reaches beyond its
  // outermost sensors, so neighbouring sensors' areas meet.
  const segmentPad = mode === 'segments' ? segmentPadding(points.map(toView), planUnit) : 0;

  const markerRadius = (mode === 'points' ? 0.016 : 0.01) * unit;

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        height,
        borderRadius: 14,
        overflow: 'hidden',
        background: 'var(--progeo-surface)',
      }}
      onMouseLeave={() => setHover(null)}
    >
      {imageSrc ? (
        // Only measures the plan (its natural size is the coordinate
        // system); the SVG draws it, so it zooms with the overlay.
        <img
          src={imageSrc}
          alt=""
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            setImageSize(naturalWidth && naturalHeight ? [naturalWidth, naturalHeight] : null);
          }}
          style={{ display: 'none' }}
        />
      ) : (
        <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8B8383' }}>
          {'–'}
        </div>
      )}
      <svg
        ref={svgRef}
        role="img"
        aria-label={`Lageplan - ${t('heatmap_canvas_hint')}`}
        viewBox={viewBoxAttribute(box)}
        preserveAspectRatio="xMidYMid meet"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          touchAction: 'none',
          cursor: dragging ? 'grabbing' : userBox ? 'grab' : 'default',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => setUserBox(null)}
      >
        {imageSrc && imageSize && (
          <image href={imageSrc} x={0} y={0} width={viewWidth} height={viewHeight} preserveAspectRatio="none" />
        )}
        {mode === 'segments' &&
          groups.map((group) => {
            const hull = convexHull(group.points.map(toView));
            const path = `M ${hull.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`;
            const width = 2 * segmentPad;
            return (
              // The hull, stroked as wide as the padding with round joins: the
              // group's area grown evenly around its outermost sensors.
              <g key={group.key} opacity={SEGMENT_OPACITY} data-testid="zone-segment" {...groupHover(group)}>
                {group.isOver && (
                  <path
                    d={path}
                    fill={OVER_THRESHOLD_COLOR}
                    stroke={OVER_THRESHOLD_COLOR}
                    strokeWidth={width + 0.012 * unit}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )}
                <path
                  d={path}
                  fill={group.color}
                  stroke={group.color}
                  strokeWidth={width}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            );
          })}

        {groups.map((group) => {
          const coords = group.points.map((point) => toView(point).join(',')).join(' ');
          const color = group.color;
          return (
            <g key={group.key}>
              {mode === 'lines' && group.points.length > 1 && (
                <>
                  <polyline
                    points={coords}
                    fill="none"
                    stroke={color}
                    strokeWidth={0.008 * unit}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {/* Wider invisible hit area for hovering the line. */}
                  <polyline
                    data-testid="zone-line"
                    points={coords}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={0.03 * unit}
                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                    onMouseMove={(event) => hoverAt(event, { group })}
                    onMouseLeave={() => setHover(null)}
                  />
                </>
              )}
              {group.points.map((point) => {
                const [cx, cy] = toView(point);
                // A line is one sensor run: its strongest reading colours
                // every dot, and all of them turn red with it.
                const asLine = mode === 'lines' && group.points.length > 1;
                const over = asLine ? group.isOver : isOverThreshold(point);
                const fill = asLine ? group.color : pointColor(point);
                return (
                  <g key={point.pos}>
                    <circle
                      cx={cx}
                      cy={cy}
                      r={markerRadius}
                      fill={fill}
                      stroke={over ? OVER_THRESHOLD_COLOR : '#ffffff'}
                      strokeWidth={(over ? 0.005 : 0.003) * unit}
                    />
                    {mode === 'points' && point.name && (
                      <text
                        x={cx + markerRadius * 1.6}
                        y={cy + 0.008 * unit}
                        fontSize={0.022 * unit}
                        fill="var(--progeo-blue)"
                        style={{ paintOrder: 'stroke', stroke: '#ffffff', strokeWidth: 0.005 * unit, pointerEvents: 'none' }}
                      >
                        {point.name}
                      </text>
                    )}
                    <circle
                      data-testid="zone-point"
                      cx={cx}
                      cy={cy}
                      r={Math.max(0.022 * unit, markerRadius * 1.5)}
                      fill="transparent"
                      style={{ cursor: 'pointer' }}
                      onMouseMove={(event) => hoverAt(event, asLine ? { group } : { point })}
                      onMouseLeave={() => setHover(null)}
                    />
                  </g>
                );
              })}
              {mode !== 'points' && group.label && (
                <GroupLabel group={group} mode={mode} toView={toView} unit={unit} />
              )}
            </g>
          );
        })}
      </svg>

      <ZoomControls
        onZoomIn={() => zoomBy(ZOOM_STEP)}
        onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
        onReset={() => setUserBox(null)}
        zoomOutDisabled={userBox == null}
        resetDisabled={userBox == null}
      />

      {hover?.kind === 'point' && (
        <SensorTooltip
          sensorPos={hover.point.pos}
          // Zone names are the zone's - only the points view names sensors.
          name={mode === 'points' ? hover.point.name : null}
          meters={hover.point.meters ?? null}
          value={hover.point.value ?? Number.NaN}
          threshold={hover.point.threshold}
          cursorX={hover.cursorX}
          cursorY={hover.cursorY}
          containerWidth={hover.width}
          containerHeight={hover.height}
        />
      )}
      {hover?.kind === 'zone' && <ZoneTooltip hover={hover} group={hover.group} />}
    </div>
  );
};

/** A line's label above its first sensor, a segment's in its middle. */
const GroupLabel = ({
  group,
  mode,
  toView,
  unit,
}: {
  group: ZoneGroup;
  mode: LageplanOverlayMode;
  toView: (point: LageplanZonePoint) => [number, number];
  unit: number;
}) => {
  const positions = group.points.map(toView);
  const [x, y] = mode === 'segments'
    ? [
      positions.reduce((sum, [px]) => sum + px, 0) / positions.length,
      positions.reduce((sum, [, py]) => sum + py, 0) / positions.length - 0.025 * unit,
    ]
    : [positions[0][0], positions[0][1] - 0.02 * unit];
  return (
    <text
      x={x}
      y={y}
      fontSize={0.028 * unit}
      fill="var(--progeo-blue)"
      textAnchor="middle"
      style={{ paintOrder: 'stroke', stroke: '#ffffff', strokeWidth: 0.006 * unit, pointerEvents: 'none' }}
    >
      {group.label}
    </text>
  );
};

/** The zone of a hovered line or segment: its sensors and the highest current value. */
const ZoneTooltip = ({ hover, group }: { hover: Hover; group: ZoneGroup }) => {
  const highest = highestPoint(group.points);
  const threshold = highest?.threshold ?? group.points[0]?.threshold ?? null;
  return (
    <CursorTooltip
      width={210}
      dotColor={alarmHeatColor({ threshold, max_value: highest?.value ?? 0, max_values: [] })}
      title={group.label ?? `Sensor #${group.points[0].pos}`}
      cursorX={hover.cursorX}
      cursorY={hover.cursorY}
      containerWidth={hover.width}
      containerHeight={hover.height}
    >
      <TooltipRow label="Sensors">{group.points.map((point) => `#${point.pos}`).join(', ')}</TooltipRow>
      {highest && (
        <TooltipRow label="Highest">
          {Math.round((highest.value as number) * 100) / 100} (#{highest.pos})
        </TooltipRow>
      )}
      {threshold != null && <TooltipRow label="Threshold">{threshold}</TooltipRow>}
    </CursorTooltip>
  );
};

/**
 * Points sharing a group key (`group`, else `name`) form one line/segment, in
 * sensor order; points without one stand alone (drawn first). The points
 * view keeps every sensor on its own.
 */
const groupPoints = (points: LageplanZonePoint[], mode: LageplanOverlayMode): ZoneGroup[] => {
  const groups: ZoneGroup[] = [];
  const byKey = new Map<string, LageplanZonePoint[]>();
  const single = (point: LageplanZonePoint) =>
    groups.push(makeGroup(`single-${point.pos}`, mode === 'points' ? null : point.name, [point]));

  points.forEach((point) => {
    const key = point.group !== undefined ? point.group : point.name;
    if (!key || mode === 'points') {
      single(point);
      return;
    }
    const list = byKey.get(key) ?? [];
    list.push(point);
    byKey.set(key, list);
  });

  byKey.forEach((list, key) => {
    const sorted = [...list].sort((a, b) => a.pos - b.pos);
    const label = sorted[0].groupLabel !== undefined ? sorted[0].groupLabel : sorted[0].name;
    groups.push(makeGroup(key, label ?? null, sorted));
  });
  return groups;
};

const makeGroup = (key: string, label: string | null, points: LageplanZonePoint[]): ZoneGroup => {
  const highest = highestPoint(points);
  return {
    key,
    label,
    points,
    isOver: points.some(isOverThreshold),
    color: highest ? pointColor(highest) : pointColor(points[0]),
  };
};

const highestPoint = (points: LageplanZonePoint[]) =>
  points.reduce<LageplanZonePoint | null>(
    (best, point) => (point.value != null && (best?.value == null || point.value > best.value) ? point : best),
    null,
  );

/** The heatmap's colour of a sensor's current value. */
const pointColor = (point: LageplanZonePoint) =>
  alarmHeatColor({ threshold: point.threshold, max_value: point.value ?? 0, max_values: [] });

const isOverThreshold = (point: LageplanZonePoint) =>
  point.value != null && point.threshold != null && point.value > point.threshold;

/** Half the median nearest-neighbour distance (view units), within sane bounds. */
export const segmentPadding = (positions: Array<[number, number]>, unit: number) => {
  const nearest = positions
    .map(([x, y], index) =>
      positions.reduce(
        (best, [ox, oy], otherIndex) => (otherIndex === index ? best : Math.min(best, Math.hypot(x - ox, y - oy))),
        Number.POSITIVE_INFINITY,
      ),
    )
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const median = nearest.length ? nearest[Math.floor(nearest.length / 2)] : 0.08 * unit;
  return Math.min(Math.max(median / 2, 0.02 * unit), 0.12 * unit);
};

/** Convex hull (Andrew's monotone chain), counter-clockwise; fewer than 3 points come back as they are. */
export const convexHull = (positions: Array<[number, number]>): Array<[number, number]> => {
  const sorted = [...positions].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) {
    return sorted;
  }
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Array<[number, number]>) => {
    const hull: Array<[number, number]> = [];
    list.forEach((point) => {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) {
        hull.pop();
      }
      hull.push(point);
    });
    hull.pop();
    return hull;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
};

export default LageplanZoneOverlay;
