import { useEffect, useMemo, useState } from 'react';
import { Card } from 'react-bootstrap';
import Plot from 'react-plotly.js';
import { plotSeriesColors, plotTheme } from '../../styles/plotTheme';

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

const MeasurementSamplesCompareChart = (
  props: MeasurementSamplesCompareChartProps,
) => {
  const { rows } = props;
  const [hiddenSeriesIds, setHiddenSeriesIds] = useState<Set<number>>(
    new Set(),
  );

  const series: DiffSeries[] = useMemo(
    () =>
      rows.map((row, index) => ({
        id: row.id,
        label: `#${row.id} | Device ${row.device} | ${formatDate(row.last_fetched)}`,
        points: toPairAbsDiff(row.samples, row.pair_abs_values),
        color: plotSeriesColors[index % plotSeriesColors.length],
      })),
    [rows],
  );

  useEffect(() => {
    setHiddenSeriesIds((previous) => {
      const currentIds = new Set(series.map((entry) => entry.id));
      const next = new Set<number>();
      previous.forEach((id) => {
        if (currentIds.has(id)) {
          next.add(id);
        }
      });
      return next;
    });
  }, [series]);

  const visibleSeries = useMemo(
    () => series.filter((entry) => !hiddenSeriesIds.has(entry.id)),
    [series, hiddenSeriesIds],
  );

  const meanSeries = useMemo(() => {
    const sums: number[] = [];
    const counts: number[] = [];

    visibleSeries.forEach((entry) => {
      entry.points.forEach((point) => {
        const index = point.pairIndex;
        sums[index] = (sums[index] || 0) + point.value;
        counts[index] = (counts[index] || 0) + 1;
      });
    });

    const x: number[] = [];
    const y: number[] = [];
    counts.forEach((count, index) => {
      if (!count) {
        return;
      }
      x.push(index);
      y.push((sums[index] || 0) / count);
    });

    return { x, y };
  }, [visibleSeries]);

  const overallVisibleMean = useMemo(() => {
    if (!meanSeries.y.length) {
      return 0;
    }
    const sum = meanSeries.y.reduce((acc, value) => acc + value, 0);
    return sum / meanSeries.y.length;
  }, [meanSeries]);

  const traces = useMemo(() => {
    const baseTraces = series.map((entry) => ({
      type: 'scattergl' as const,
      mode: 'lines' as const,
      name: entry.label,
      x: entry.points.map((point) => point.pairIndex),
      y: entry.points.map((point) => point.value),
      line: {
        color: entry.color,
        width: 2,
      },
      visible: hiddenSeriesIds.has(entry.id) ? 'legendonly' : true,
      hovertemplate:
        'Pair %{x}<br>Delta %{y:.2f}<br>' + `${entry.label}<extra></extra>`,
    }));

    return [
      ...baseTraces,
      {
        type: 'scattergl' as const,
        mode: 'lines' as const,
        name: 'Mean (visible)',
        x: meanSeries.x,
        y: meanSeries.y,
        line: {
          color: plotTheme.brandBlue,
          width: 3,
          dash: 'dash',
        },
        hovertemplate:
          'Pair %{x}<br>Visible mean %{y:.2f}<extra>Mean (visible)</extra>',
      },
    ];
  }, [series, hiddenSeriesIds, meanSeries]);

  return (
    <Card className="border-0 shadow-sm">
      <Card.Body>
        <div className="d-flex flex-wrap justify-content-between align-items-center mb-2">
          <h5 className="mb-0">Sample Pair Delta Comparison</h5>
          <small className="text-muted">
            Each point is |sample[2i] - sample[2i+1]| for one measurement.
          </small>
        </div>

        <div className="d-flex flex-wrap justify-content-between align-items-center mb-2">
          <small className="text-muted">
            Selected plots: {visibleSeries.length} / {series.length}
          </small>
          <small className="fw-semibold text-dark">
            Visible mean: {overallVisibleMean.toFixed(2)}
          </small>
        </div>

        <Plot
          data={traces}
          useResizeHandler
          style={{ width: '100%', height: '520px' }}
          config={{
            responsive: true,
            displaylogo: false,
            scrollZoom: true,
          }}
          layout={{
            autosize: true,
            margin: { l: 56, r: 16, t: 16, b: 52 },
            font: { color: plotTheme.brandBlue },
            plot_bgcolor: plotTheme.warmGray1,
            paper_bgcolor: plotTheme.white,
            xaxis: {
              title: 'Pair Index',
              showgrid: true,
              gridcolor: plotTheme.warmGray2,
              zeroline: false,
            },
            yaxis: {
              title: 'Absolute Delta',
              rangemode: 'tozero',
              showgrid: true,
              gridcolor: plotTheme.warmGray2,
              zeroline: false,
            },
            legend: {
              orientation: 'h',
              y: -0.25,
              x: 0,
              bgcolor: plotTheme.warmGray1,
              bordercolor: plotTheme.warmGray3,
              borderwidth: 1,
            },
            hovermode: 'x unified',
            hoverlabel: {
              bgcolor: plotTheme.brandBlue,
              bordercolor: plotTheme.warmGray3,
              font: { color: plotTheme.white },
            },
          }}
          onLegendClick={(event) => {
            const traceIndex = event.curveNumber;
            if (traceIndex === undefined || traceIndex < 0) {
              return false;
            }
            if (traceIndex >= series.length) {
              return false;
            }

            const selectedId = series[traceIndex]?.id;
            if (!selectedId) {
              return false;
            }

            setHiddenSeriesIds((previous) => {
              const next = new Set(previous);
              if (next.has(selectedId)) {
                next.delete(selectedId);
              } else {
                next.add(selectedId);
              }
              return next;
            });

            return false;
          }}
          onDoubleClick={() => {
            setHiddenSeriesIds(new Set());
            return false;
          }}
        />
      </Card.Body>
    </Card>
  );
};

export default MeasurementSamplesCompareChart;
