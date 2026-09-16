export type LageplanZonePoint = {
  pos: number;
  x: number;
  y: number;
  name: string | null;
  value: number | null;
  threshold: number | null;
};

type LageplanZoneOverlayProps = {
  imageUrl: string | null;
  points: LageplanZonePoint[];
  height?: number;
};

const getBackendUrl = (path: string) => {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const backendUrl = import.meta.env.VITE_BACKEND_URL || window.location.origin;
  return `${backendUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
};

type ZoneGroup = {
  name: string | null;
  points: LageplanZonePoint[];
  isOver: boolean;
};

/**
 * DFH-specific Lageplan visualization (Status tab): instead of the
 * continuous Gaussian heat field SensorHeatmap2D draws for smartex/other
 * project types, DFH locations combine every ProgeoMeasurePoint sharing the
 * same `name` (a roof zone, e.g. "Hauptdach") into one connecting line drawn
 * over the Lageplan image - a zone is one physical run of sensors, not a
 * point cloud.
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

  return (
    <div style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', background: 'var(--progeo-surface)' }}>
      {resolvedUrl ? (
        <img
          src={resolvedUrl}
          alt="Lageplan"
          style={{ width: '100%', height, objectFit: 'contain', display: 'block' }}
        />
      ) : (
        <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8B8383' }}>
          {'–'}
        </div>
      )}
      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="xMidYMid meet"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      >
        {groups.map((group) => {
          const color = group.isOver ? 'var(--progeo-orange)' : 'var(--progeo-blue)';
          const label = group.name ?? `#${group.points[0].pos}`;
          return (
            <g key={group.name ?? `single-${group.points[0].pos}`}>
              {group.points.length > 1 && (
                <polyline
                  points={group.points.map((point) => `${point.x},${point.y}`).join(' ')}
                  fill="none"
                  stroke={color}
                  strokeWidth={0.008}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
              {group.points.map((point) => (
                <circle key={point.pos} cx={point.x} cy={point.y} r={0.01} fill={color} stroke="#ffffff" strokeWidth={0.003} />
              ))}
              <text
                x={group.points[0].x}
                y={group.points[0].y - 0.02}
                fontSize={0.028}
                fill={color}
                textAnchor="middle"
                style={{ paintOrder: 'stroke', stroke: '#ffffff', strokeWidth: 0.006 }}
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};

const isOverThreshold = (point: LageplanZonePoint) =>
  point.value != null && point.threshold != null && point.value > point.threshold;

export default LageplanZoneOverlay;
