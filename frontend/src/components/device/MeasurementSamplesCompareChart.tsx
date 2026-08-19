import React from 'react';
import { Button, Card } from 'react-bootstrap';
import Plot from 'react-plotly.js';
import { useTranslation } from 'react-i18next';
import { plotTheme } from '../../styles/plotTheme';

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
  lastFetched: string | null;
  points: DiffPoint[];
};

type MeasurementSamplesCompareChartProps = {
  rows: MeasurementCompareRow[];
  onLoadCurrentYear?: (() => void) | null;
  isLoadingCurrentYear?: boolean;
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

const formatDateTime = (value: string | null | undefined) => {
  if (!value) {
    return '-';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(parsed);
};

const MeasurementSamplesCompareChart = (
  props: MeasurementSamplesCompareChartProps,
) => {
  const {
    rows,
    onLoadCurrentYear = null,
    isLoadingCurrentYear = false,
  } = props;
  const { t } = useTranslation();
  const currentYear = new Date().getFullYear();

  const series: DiffSeries[] = React.useMemo(
    () =>
      rows.map((row) => ({
        id: row.id,
        lastFetched: row.last_fetched,
        points: toPairAbsDiff(row.samples, row.pair_abs_values),
      })),
    [rows],
  );

  const meanAndDeviationSeries = React.useMemo(() => {
    const sums: number[] = [];
    const sumsSquared: number[] = [];
    const counts: number[] = [];

    series.forEach((entry) => {
      entry.points.forEach((point) => {
        const index = point.pairIndex;
        sums[index] = (sums[index] || 0) + point.value;
        sumsSquared[index] =
          (sumsSquared[index] || 0) + point.value * point.value;
        counts[index] = (counts[index] || 0) + 1;
      });
    });

    const x: number[] = [];
    const mean: number[] = [];
    const upper: number[] = [];
    const lower: number[] = [];
    const sigma: number[] = [];

    counts.forEach((count, index) => {
      if (!count) {
        return;
      }
      const currentSum = sums[index] || 0;
      const currentSumSq = sumsSquared[index] || 0;
      const avg = currentSum / count;
      const variance = Math.max(currentSumSq / count - avg * avg, 0);
      const stdDev = Math.sqrt(variance);

      x.push(index);
      mean.push(avg);
      sigma.push(stdDev);
      lower.push(Math.max(avg - stdDev, 0));
      upper.push(avg + stdDev);
    });

    return { x, mean, upper, lower, sigma };
  }, [series]);

  const overallMean = React.useMemo(() => {
    if (!meanAndDeviationSeries.mean.length) {
      return 0;
    }
    const sum = meanAndDeviationSeries.mean.reduce(
      (acc, value) => acc + value,
      0,
    );
    return sum / meanAndDeviationSeries.mean.length;
  }, [meanAndDeviationSeries]);

  const averageSigma = React.useMemo(() => {
    if (!meanAndDeviationSeries.sigma.length) {
      return 0;
    }
    const sum = meanAndDeviationSeries.sigma.reduce(
      (acc, value) => acc + value,
      0,
    );
    return sum / meanAndDeviationSeries.sigma.length;
  }, [meanAndDeviationSeries]);

  const pairSumSeries = React.useMemo(() => {
    const orderedSeries = [...series].reverse();

    const x = orderedSeries.map((_, index) => index);
    const y = orderedSeries.map((entry) =>
      entry.points.reduce((acc, point) => acc + point.value, 0),
    );
    const measurementDateTime = orderedSeries.map((entry) =>
      formatDateTime(entry.lastFetched),
    );

    return { x, y, measurementDateTime };
  }, [series]);

  const traces = React.useMemo(() => {
    return [
      {
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: t('measurement_compare_deviation_label'),
        x: meanAndDeviationSeries.x,
        y: meanAndDeviationSeries.upper,
        line: {
          color: 'rgba(36, 74, 132, 0)',
          width: 1,
        },
        hoverinfo: 'skip' as const,
      },
      {
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: t('measurement_compare_deviation_lower_bound_label'),
        x: meanAndDeviationSeries.x,
        y: meanAndDeviationSeries.lower,
        line: {
          color: 'rgba(196, 49, 151, 0)',
          width: 1,
        },
        fill: 'tonexty' as const,
        fillcolor: 'rgba(252, 122, 46, 0.31)',
        hovertemplate: `${t('measurement_compare_pair_label')} %{x}<br>${t('measurement_compare_range_label')} %{customdata[0]:.2f} - %{customdata[1]:.2f}<extra>${t('measurement_compare_deviation_label')}</extra>`,
        customdata: meanAndDeviationSeries.x.map((_, index) => [
          meanAndDeviationSeries.lower[index],
          meanAndDeviationSeries.upper[index],
        ]),
        showlegend: false,
      },
      {
        type: 'scattergl' as const,
        mode: 'lines' as const,
        name: t('measurement_compare_mean_label'),
        x: meanAndDeviationSeries.x,
        y: meanAndDeviationSeries.mean,
        line: {
          color: plotTheme.brandBlue,
          width: 3,
        },
        hovertemplate: `${t('measurement_compare_pair_label')} %{x}<br>${t('measurement_compare_mean_label')} %{y:.2f}<br>${t('measurement_compare_sigma_label')} %{customdata:.2f}<extra>${t('measurement_compare_mean_label')}</extra>`,
        customdata: meanAndDeviationSeries.sigma,
      },
      {
        type: 'scattergl' as const,
        mode: 'lines' as const,
        name: t('measurement_compare_pair_sum_label'),
        x: pairSumSeries.x,
        y: pairSumSeries.y,
        xaxis: 'x2' as const,
        yaxis: 'y2' as const,
        line: {
          color: 'rgba(44, 160, 44, 0.95)',
          width: 2,
        },
        hovertemplate: `${t('measurement_compare_pair_label')} %{x}<br>${t('measurement_compare_sum_label')} %{y:.2f}<br>${t('measurement_compare_measurement_datetime_label')} %{customdata}<extra>${t('measurement_compare_pair_sum_label')}</extra>`,
        customdata: pairSumSeries.measurementDateTime,
      },
    ];
  }, [meanAndDeviationSeries, pairSumSeries, t]);

  return (
    <Card className="border-0 shadow-sm p-3">
      <Card.Body>
        <div className="d-flex flex-wrap justify-content-between align-items-center mb-2">
          <div className="d-flex flex-wrap align-items-center gap-2">
            <small className="text-muted">
              {t('measurement_compare_measurements_included')}: {series.length}
            </small>
            {onLoadCurrentYear && (
              <Button
                size="sm"
                variant="outline-primary"
                onClick={onLoadCurrentYear}
                disabled={isLoadingCurrentYear}
              >
                {isLoadingCurrentYear
                  ? `Loading ${currentYear}...`
                  : `Load ${currentYear}`}
              </Button>
            )}
          </div>
          <small className="fw-semibold text-dark">
            {t('measurement_compare_mean_avg_sigma_summary', {
              mean: overallMean.toFixed(2),
              avgSigma: averageSigma.toFixed(2),
            })}
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
              title: t('measurement_compare_pair_index_axis'),
              domain: [0, 1],
              anchor: 'y',
              showgrid: true,
              gridcolor: plotTheme.warmGray2,
              zeroline: false,
            },
            yaxis: {
              title: t('measurement_compare_absolute_delta_axis'),
              domain: [0.34, 1],
              rangemode: 'tozero',
              showgrid: true,
              gridcolor: plotTheme.warmGray2,
              zeroline: false,
            },
            xaxis2: {
              title: t('measurement_compare_pair_index_axis'),
              domain: [0, 1],
              anchor: 'y2',
              showgrid: true,
              gridcolor: plotTheme.warmGray2,
              zeroline: false,
            },
            yaxis2: {
              title: t('measurement_compare_pair_sum_axis'),
              domain: [0, 0.24],
              side: 'left',
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
        />
      </Card.Body>
    </Card>
  );
};

export default MeasurementSamplesCompareChart;
