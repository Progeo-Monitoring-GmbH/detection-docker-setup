import React from 'react';
import { Card } from 'react-bootstrap';

export type MeasurementCompareRow = {
  id: number;
  device: number;
  last_fetched: string | null;
  samples: number[];
  pair_abs_values?: number[];
};

type DiffPoint = {
  pairIndex: number;
  value: number;
};

type DiffSeries = {
  id: number;
  label: string;
  points: DiffPoint[];
  color: string;
};

type MeasurementSamplesCompareChartProps = {
  rows: MeasurementCompareRow[];
};

const COLORS = [
  '#2563eb',
  '#dc2626',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#0f766e',
  '#be123c',
  '#374151',
];

const formatDate = (value: string | null | undefined) => {
  if (!value) {
    return '-';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
};

const toPairAbsDiff = (
  samples: number[] | null | undefined,
  pairAbsValues?: number[] | null,
): DiffPoint[] => {
  if (Array.isArray(pairAbsValues) && pairAbsValues.length) {
    return pairAbsValues.map((value, index) => ({
      pairIndex: index,
      value: Number(value || 0),
    }));
  }

  if (!Array.isArray(samples) || !samples.length) {
    return [];
  }

  const points: DiffPoint[] = [];
  const pairCount = Math.floor(samples.length / 2);
  for (let i = 0; i < pairCount; i += 1) {
    const left = Number(samples[i * 2] || 0);
    const right = Number(samples[i * 2 + 1] || 0);
    points.push({ pairIndex: i, value: Math.abs(left - right) });
  }
  return points;
};

const buildPath = (
  points: DiffPoint[],
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  width: number,
  height: number,
) => {
  if (!points.length) {
    return '';
  }

  const plotLeft = 44;
  const plotRight = width - 18;
  const plotTop = 20;
  const plotBottom = height - 32;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const xRange = maxX - minX || 1;
  const yRange = maxY - minY || 1;

  return points
    .map((point) => {
      const x = plotLeft + ((point.pairIndex - minX) / xRange) * plotWidth;
      const y = plotBottom - ((point.value - minY) / yRange) * plotHeight;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
};

class MeasurementSamplesCompareChart extends React.PureComponent<MeasurementSamplesCompareChartProps> {
  render() {
    const { rows } = this.props;
    const width = 920;
    const height = 320;

    const series: DiffSeries[] = rows.map((row, index) => ({
      id: row.id,
      label: `#${row.id} | Device ${row.device} | ${formatDate(row.last_fetched)}`,
      points: toPairAbsDiff(row.samples, row.pair_abs_values),
      color: COLORS[index % COLORS.length],
    }));

    const allPoints = series.flatMap((entry) => entry.points);
    const minX = allPoints.length
      ? Math.min(...allPoints.map((p) => p.pairIndex))
      : 0;
    const maxX = allPoints.length
      ? Math.max(...allPoints.map((p) => p.pairIndex))
      : 1;
    const minY = 0;
    const maxYRaw = allPoints.length
      ? Math.max(...allPoints.map((p) => p.value))
      : 1;
    const maxY = maxYRaw <= 0 ? 1 : maxYRaw;

    return (
      <Card className="border-0 shadow-sm">
        <Card.Body>
          <div className="d-flex flex-wrap justify-content-between align-items-center mb-2">
            <h5 className="mb-0">Sample Pair Delta Comparison</h5>
            <small className="text-muted">
              Each point is |sample[2i] - sample[2i+1]| for one measurement.
            </small>
          </div>

          <svg
            viewBox={`0 0 ${width} ${height}`}
            width="100%"
            role="img"
            aria-label="Measurement samples comparison"
          >
            <rect
              x="44"
              y="20"
              width={width - 62}
              height={height - 52}
              fill="#f8fbff"
              rx="8"
            />
            <line
              x1="44"
              y1={height - 32}
              x2={width - 18}
              y2={height - 32}
              stroke="#9cb5cc"
              strokeWidth="1"
            />
            <line
              x1="44"
              y1="20"
              x2="44"
              y2={height - 32}
              stroke="#9cb5cc"
              strokeWidth="1"
            />

            {series.map((entry) => {
              const path = buildPath(
                entry.points,
                minX,
                maxX,
                minY,
                maxY,
                width,
                height,
              );
              if (!path) {
                return null;
              }
              return (
                <polyline
                  key={entry.id}
                  fill="none"
                  stroke={entry.color}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points={path}
                />
              );
            })}

            <text x="44" y={height - 10} fill="#5f6e7c" fontSize="11">
              Pair {minX}
            </text>
            <text
              x={width - 18}
              y={height - 10}
              fill="#5f6e7c"
              fontSize="11"
              textAnchor="end"
            >
              Pair {maxX}
            </text>
            <text x="10" y="24" fill="#5f6e7c" fontSize="11">
              {maxY.toFixed(0)}
            </text>
            <text x="16" y={height - 34} fill="#5f6e7c" fontSize="11">
              {minY.toFixed(0)}
            </text>
          </svg>

          <div className="mt-3 d-flex flex-column gap-1">
            {series.map((entry) => (
              <small
                key={`legend-${entry.id}`}
                className="d-flex align-items-center gap-2"
              >
                <span
                  style={{
                    width: 14,
                    height: 3,
                    backgroundColor: entry.color,
                    display: 'inline-block',
                  }}
                />
                <span>{entry.label}</span>
              </small>
            ))}
          </div>
        </Card.Body>
      </Card>
    );
  }
}

export default MeasurementSamplesCompareChart;
