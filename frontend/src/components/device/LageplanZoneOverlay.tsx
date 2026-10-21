import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { getBackendUrl } from '../../backendUrl';
import { alarmHeatColor } from '../../main/alarmUtils';
import CursorTooltip, { TooltipRow } from '../ui/CursorTooltip';
import SensorTooltip from './SensorTooltip';

export type LageplanZonePoint = {
  pos: number;
  /** Normalized position on the plan image (0..1, y downwards). */
  x: number;
  y: number;
  name: string | null;
  value: number | null;
  threshold: number | null;
  /** Position in meters; null while the plan isn't calibrated. */
  meters?: [number, number] | null;
};

type LageplanZoneOverlayProps = {
  imageUrl: string | null;
  points: LageplanZonePoint[];
  height?: number;
};

type ZoneGroup = {
  name: string | null;
  points: LageplanZonePoint[];
  isOver: boolean;
};

type Hover = {
  cursorX: number;
  cursorY: number;
  width: number;
  height: number;
} & ({ kind: 'point'; point: LageplanZonePoint } | { kind: 'zone'; group: ZoneGroup });

/**
 * smartex® is-specific Lageplan visualization (Status tab): instead of the
 * continuous Gaussian heat field SensorHeatmap2D draws for smartex/other
 * project types, smartex® is locations combine every ProgeoMeasurePoint sharing the
 * same `name` (a roof zone, e.g. "Hauptdach") into one connecting line drawn
 * over the Lageplan image - a zone is one physical run of sensors, not a
 * point cloud. Hovering a sensor shows its values, hovering a line the zone's.
 *
 * The overlay uses the image's own size as viewBox, so with the same
 * "contain" fit as the image it lands exactly on it (a square viewBox would
 * squeeze the points towards the middle of a wide plan).
 */
const LageplanZoneOverlay = ({ imageUrl, points, height = 480 }: LageplanZoneOverlayProps) => {
  const groups: ZoneGroup[] = [];
  const byName = new Map<string, LageplanZonePoint[]>();

  points.forEach((point) => {
    if (!point.name) {
      groups.push({ name: null, points: [point], isOver: isOverThreshold(point) });
      return;
    }
    const list = byName.get(point.name) ?? [];
    list.push(point);
    byName.set(point.name, list);
  });

  byName.forEach((list, name) => {
    const sorted = [...list].sort((a, b) => a.pos - b.pos);
    groups.push({ name, points: sorted, isOver: sorted.some(isOverThreshold) });
  });

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

  // Without the image (yet) the points span a square, as before.
  const [viewWidth, viewHeight] = imageSize ?? [1, 1];
  // Sizes relative to the shorter side, so markers look the same on any plan.
  const unit = Math.min(viewWidth, viewHeight);

  const hoverAt = (event: MouseEvent, target: { point: LageplanZonePoint } | { group: ZoneGroup }) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
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

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', background: 'var(--progeo-surface)' }}
      onMouseLeave={() => setHover(null)}
    >
      {imageSrc ? (
        <img
          src={imageSrc}
          alt="Lageplan"
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            setImageSize(naturalWidth && naturalHeight ? [naturalWidth, naturalHeight] : null);
          }}
          style={{ width: '100%', height, objectFit: 'contain', display: 'block' }}
        />
      ) : (
        <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8B8383' }}>
          {'–'}
        </div>
      )}
      <svg
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      >
        {groups.map((group) => {
          const color = group.isOver ? 'var(--progeo-orange)' : 'var(--progeo-blue)';
          const label = group.name ?? `#${group.points[0].pos}`;
          const coords = group.points.map((point) => `${point.x * viewWidth},${point.y * viewHeight}`).join(' ');
          return (
            <g key={group.name ?? `single-${group.points[0].pos}`}>
              {group.points.length > 1 && (
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
              {group.points.map((point) => (
                <g key={point.pos}>
                  <circle
                    cx={point.x * viewWidth}
                    cy={point.y * viewHeight}
                    r={0.01 * unit}
                    fill={color}
                    stroke="#ffffff"
                    strokeWidth={0.003 * unit}
                  />
                  <circle
                    data-testid="zone-point"
                    cx={point.x * viewWidth}
                    cy={point.y * viewHeight}
                    r={0.022 * unit}
                    fill="transparent"
                    style={{ cursor: 'pointer' }}
                    onMouseMove={(event) => hoverAt(event, { point })}
                    onMouseLeave={() => setHover(null)}
                  />
                </g>
              ))}
              <text
                x={group.points[0].x * viewWidth}
                y={(group.points[0].y - 0.02) * viewHeight}
                fontSize={0.028 * unit}
                fill={color}
                textAnchor="middle"
                style={{ paintOrder: 'stroke', stroke: '#ffffff', strokeWidth: 0.006 * unit, pointerEvents: 'none' }}
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>

      {hover?.kind === 'point' && (
        <SensorTooltip
          sensorPos={hover.point.pos}
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

/** The zone of a hovered line: its sensors and the highest current value. */
const ZoneTooltip = ({ hover, group }: { hover: Hover; group: ZoneGroup }) => {
  const highest = group.points.reduce<LageplanZonePoint | null>(
    (best, point) => (point.value != null && (best?.value == null || point.value > best.value) ? point : best),
    null,
  );
  const threshold = highest?.threshold ?? group.points[0]?.threshold ?? null;
  return (
    <CursorTooltip
      width={210}
      dotColor={alarmHeatColor({ threshold, max_value: highest?.value ?? 0, max_values: [] })}
      title={group.name ?? `Sensor #${group.points[0].pos}`}
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

const isOverThreshold = (point: LageplanZonePoint) =>
  point.value != null && point.threshold != null && point.value > point.threshold;

export default LageplanZoneOverlay;
