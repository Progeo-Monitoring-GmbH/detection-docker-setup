import { Card } from 'react-bootstrap';
import React from 'react';
import { plotTheme } from '../../styles/plotTheme';

export type TimePoint = {
  id: number;
  timeMs: number;
  timeLabel: string;
  avg: number;
  max: number;
};

export type DeviceSeries = {
  deviceId: number;
  label: string;
  points: TimePoint[];
};

const buildPointsPath = (
  points: TimePoint[],
  valueSelector: (point: TimePoint) => number,
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

  const plotLeft = 40;
  const plotRight = width - 12;
  const plotTop = 16;
  const plotBottom = height - 28;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const xRange = maxX - minX || 1;
  const yRange = maxY - minY || 1;

  return points
    .map((point) => {
      const x = plotLeft + ((point.timeMs - minX) / xRange) * plotWidth;
      const y =
        plotBottom - ((valueSelector(point) - minY) / yRange) * plotHeight;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
};

type DeviceChartProps = {
  series: DeviceSeries;
};

class DeviceChart extends React.PureComponent<DeviceChartProps> {
  render() {
    const { series } = this.props;
    const width = 860;
    const height = 240;

    const minX = series.points[0]?.timeMs ?? 0;
    const maxX = series.points[series.points.length - 1]?.timeMs ?? 1;

    const allValues = series.points.flatMap((point) => [point.avg, point.max]);
    const minYRaw = allValues.length ? Math.min(...allValues) : 0;
    const maxYRaw = allValues.length ? Math.max(...allValues) : 1;
    const pad = Math.max((maxYRaw - minYRaw) * 0.1, 0.5);
    const minY = minYRaw - pad;
    const maxY = maxYRaw + pad;

    const avgPath = buildPointsPath(
      series.points,
      (point) => point.avg,
      minX,
      maxX,
      minY,
      maxY,
      width,
      height,
    );
    const maxPath = buildPointsPath(
      series.points,
      (point) => point.max,
      minX,
      maxX,
      minY,
      maxY,
      width,
      height,
    );

    const latest = series.points[series.points.length - 1];

    return (
      <Card className="mb-3 border-0 shadow-sm">
        <Card.Body>
          <div className="d-flex flex-wrap justify-content-between align-items-center mb-2">
            <h5 className="mb-0">{series.label}</h5>
            <small className="text-muted">
              {series.points.length} measurements, latest:{' '}
              {latest?.timeLabel || '-'}
            </small>
          </div>

          <svg
            viewBox={`0 0 ${width} ${height}`}
            width="100%"
            role="img"
            aria-label={`${series.label} chart`}
          >
            <rect
              x="40"
              y="16"
              width={width - 52}
              height={height - 44}
              fill={plotTheme.warmGray1}
              rx="8"
            />
            <line
              x1="40"
              y1={height - 28}
              x2={width - 12}
              y2={height - 28}
              stroke={plotTheme.warmGray4}
              strokeWidth="1"
            />
            <line
              x1="40"
              y1="16"
              x2="40"
              y2={height - 28}
              stroke={plotTheme.warmGray4}
              strokeWidth="1"
            />

            {maxPath && (
              <polyline
                fill="none"
                stroke={plotTheme.brandOrange}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={maxPath}
              />
            )}
            {avgPath && (
              <polyline
                fill="none"
                stroke={plotTheme.brandBlue}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={avgPath}
              />
            )}

            <text x="40" y={height - 8} fill={plotTheme.brandBlue} fontSize="11">
              {series.points[0]?.timeLabel || ''}
            </text>
            <text
              x={width - 12}
              y={height - 8}
              fill={plotTheme.brandBlue}
              fontSize="11"
              textAnchor="end"
            >
              {series.points[series.points.length - 1]?.timeLabel || ''}
            </text>
            <text x="8" y="22" fill={plotTheme.brandBlue} fontSize="11">
              {maxYRaw.toFixed(2)}
            </text>
            <text x="8" y={height - 30} fill={plotTheme.brandBlue} fontSize="11">
              {minYRaw.toFixed(2)}
            </text>
          </svg>

          <div className="mt-2 d-flex gap-3 flex-wrap">
            <small style={{ color: plotTheme.brandBlue }}>Blue: average sample</small>
            <small style={{ color: plotTheme.brandOrange }}>Orange: max sample</small>
          </div>
        </Card.Body>
      </Card>
    );
  }
}
export default DeviceChart;
