import React from 'react';
import { Button, Card } from 'react-bootstrap';
import Plot from 'react-plotly.js';
import { useTranslation } from 'react-i18next';
import { parseTimestamp } from '../../main/alarmUtils';
import { plotTheme } from '../../styles/plotTheme';
import FrameSlider from './FrameSlider';

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
  /**
   * Alarm start (epoch ms). Marks the measurement at which the alarm started
   * with a red transparent band on the measurement-time axis (x2).
   */
  alarmStartTime?: number | null;
  /**
   * Alarm duration (ms). The red band spans from the measurement closest to
   * `alarmStartTime` to the one closest to `alarmStartTime + alarmDurationMs`
   * (a single column when the duration is missing or zero).
   */
  alarmDurationMs?: number | null;
  /**
   * Time slider over the measurements (as on the heatmap): the selected
   * measurement's EP - WP, EP and WP (optional EP + WP, WP - EP) are drawn
   * on the upper plot, its time is marked on the lower one. Legend on top.
   */
  frameSlider?: boolean;
  /** Whether the space bar plays the time slider - off next to a heatmap, whose slider has it. */
  sliderPlayKey?: boolean;
  /** Skip the component's own Card chrome so it can sit inside another panel wrapper. */
  hideChrome?: boolean;
};

/** Traces without highlighting and that a legend click doesn't hide. */
const FIXED_TRACES = new Set(['deviation', 'deviation-lower', 'pair-sum']);

/** How close (px) the cursor must be to a line to highlight it. */
const HIGHLIGHT_DISTANCE_PX = 12;

/** One measurement of the time slider, oldest first. */
type Frame = {
  id: number;
  /** Epoch ms. */
  ms: number;
  ep: number[];
  wp: number[];
};

/** EP / WP of the interleaved samples [eigen, wirk, ...]; an unpaired last value is dropped. */
const toPotentials = (samples: number[] | null | undefined) => {
  const ep: number[] = [];
  const wp: number[] = [];
  if (!Array.isArray(samples)) {
    return { ep, wp };
  }
  const pairCount = Math.floor(samples.length / 2);
  for (let i = 0; i < pairCount; i += 1) {
    ep.push(Number(samples[i * 2] || 0));
    wp.push(Number(samples[i * 2 + 1] || 0));
  }
  return { ep, wp };
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
    alarmStartTime = null,
    alarmDurationMs = null,
    frameSlider = false,
    sliderPlayKey = true,
    hideChrome = false,
  } = props;
  const { t } = useTranslation();
  const currentYear = new Date().getFullYear();

  const frames: Frame[] = React.useMemo(() => {
    if (!frameSlider) {
      return [];
    }
    return rows
      .flatMap((row) => {
        const ms = parseTimestamp(row.last_fetched);
        return ms == null ? [] : [{ id: row.id, ms, ...toPotentials(row.samples) }];
      })
      .sort((a, b) => a.ms - b.ms);
  }, [rows, frameSlider]);
  const sliderTimestamps = React.useMemo(() => frames.map((frame) => frame.ms / 1000), [frames]);
  // By id, so the selection survives reloads; the newest measurement by default.
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const selectedIndex = frames.findIndex((frame) => frame.id === selectedId);
  const frameIndex = selectedIndex >= 0 ? selectedIndex : frames.length - 1;
  const currentFrame = frames[frameIndex] ?? null;

  const series: DiffSeries[] = React.useMemo(
    () =>
      rows.map((row) => ({
        id: row.id,
        lastFetched: row.last_fetched,
        points: toPairAbsDiff(row.samples, row.pair_abs_values),
      })),
    [rows],
  );

  // The pair-sum subplot (x2) is a date axis, so the alarm band is positioned
  // directly by the alarm's own start/end timestamps (no index mapping).
  const alarmBandX = React.useMemo(() => {
    if (alarmStartTime == null) {
      return null;
    }
    const hasDuration = alarmDurationMs != null && alarmDurationMs > 0;
    const end =
      hasDuration && alarmStartTime + alarmDurationMs > alarmStartTime
        ? alarmStartTime + alarmDurationMs
        : alarmStartTime;
    return { start: alarmStartTime, end };
  }, [alarmStartTime, alarmDurationMs]);

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
    // The x2 subplot is a date axis: x values are the measurement timestamps
    // (epoch ms), so the axis shows real dates instead of row indices.
    const orderedSeries = [...series].reverse();

    const x: number[] = [];
    const y: number[] = [];
    const measurementDateTime: string[] = [];
    orderedSeries.forEach((entry) => {
      const ts = parseTimestamp(entry.lastFetched);
      if (ts == null) {
        return; // cannot be placed on the date axis
      }
      x.push(ts);
      y.push(entry.points.reduce((acc, point) => acc + point.value, 0));
      measurementDateTime.push(formatDateTime(entry.lastFetched));
    });

    return { x, y, measurementDateTime };
  }, [series]);

  const traces = React.useMemo(() => {
    return [
      {
        type: 'scatter' as const,
        mode: 'lines' as const,
        uid: 'deviation',
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
        uid: 'deviation-lower',
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
        // Not scattergl: a highlight (width, opacity) then only restyles.
        type: 'scatter' as const,
        mode: 'lines' as const,
        uid: 'mean',
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
        uid: 'pair-sum',
        name: t('measurement_compare_pair_sum_label'),
        x: pairSumSeries.x,
        y: pairSumSeries.y,
        xaxis: 'x2' as const,
        yaxis: 'y2' as const,
        line: {
          color: 'rgba(44, 160, 44, 0.95)',
          width: 2,
        },
        hovertemplate: `${t('measurement_compare_measurement_datetime_label')} %{customdata}<br>${t('measurement_compare_sum_label')} %{y:.2f}<extra>${t('measurement_compare_pair_sum_label')}</extra>`,
        customdata: pairSumSeries.measurementDateTime,
      },
    ];
  }, [meanAndDeviationSeries, pairSumSeries, t]);

  // The slider's measurement on the upper plot; EP + WP and WP - EP start
  // hidden (legend click). Fixed uids keep the legend toggles while sliding.
  const currentTraces = React.useMemo(() => {
    if (!currentFrame || !currentFrame.ep.length) {
      return [];
    }
    const { ep, wp } = currentFrame;
    const x = ep.map((_, index) => index);
    const line = (
      uid: string,
      name: string,
      y: number[],
      color: string,
      width: number,
      optional = false,
    ) => ({
      type: 'scatter' as const,
      mode: 'lines' as const,
      uid,
      name,
      x,
      y,
      line: { color, width },
      hovertemplate: `%{y:.2f}<extra>${name}</extra>`,
      ...(optional ? { visible: 'legendonly' as const } : {}),
    });
    return [
      line('ep-wp', 'EP − WP', ep.map((value, i) => value - wp[i]), 'orange', 2),
      line('ep', 'EP', ep, 'red', 1),
      line('wp', 'WP', wp, 'blue', 1),
      line('ep+wp', 'EP + WP', ep.map((value, i) => value + wp[i]), plotTheme.contrastViolet, 1, true),
      line('wp-ep', 'WP − EP', wp.map((value, i) => value - ep[i]), plotTheme.contrastCyan, 1, true),
    ];
  }, [currentFrame]);

  const shapes = React.useMemo(() => {
    const result: Partial<Plotly.Shape>[] = [];
    if (alarmBandX != null) {
      result.push(
        alarmBandX.end > alarmBandX.start
          ? {
              type: 'rect',
              xref: 'x2',
              yref: 'paper',
              x0: alarmBandX.start,
              x1: alarmBandX.end,
              y0: 0,
              y1: 0.24,
              fillcolor: 'rgba(220, 38, 38, 0.22)',
              line: { width: 0 },
            }
          : {
              type: 'line',
              xref: 'x2',
              yref: 'paper',
              x0: alarmBandX.start,
              x1: alarmBandX.start,
              y0: 0,
              y1: 0.24,
              line: {
                color: 'rgba(220, 38, 38, 0.6)',
                width: 2,
              },
            },
      );
    }
    if (currentFrame) {
      // The slider's time on the lower plot.
      result.push({
        type: 'line',
        xref: 'x2',
        yref: 'paper',
        x0: currentFrame.ms,
        x1: currentFrame.ms,
        y0: 0,
        y1: 0.24,
        line: { color: 'orange', width: 2, dash: 'dot' },
      });
    }
    return result;
  }, [alarmBandX, currentFrame]);

  // The line under the cursor or its legend entry is highlighted: wider,
  // the other lines faded. The fixed traces stay as they are.
  const [highlighted, setHighlighted] = React.useState<string | null>(null);
  const data = React.useMemo(() => {
    const all = [...traces, ...currentTraces];
    if (highlighted == null) {
      return all;
    }
    return all.map((trace) => {
      if (FIXED_TRACES.has(trace.uid)) {
        return trace;
      }
      return trace.uid === highlighted
        ? { ...trace, line: { ...trace.line, width: trace.line.width + 2 } }
        : { ...trace, opacity: 0.3 };
    });
  }, [traces, currentTraces, highlighted]);

  // In 'x unified' hover every line reports its point at the cursor's x: the
  // nearest one within HIGHLIGHT_DISTANCE_PX is the hovered line.
  const highlightNearestLine = (event: Readonly<Plotly.PlotHoverEvent>) => {
    // Plotly passes the hovered subplot's axes too, the typings lack them.
    const { yaxes } = event as { yaxes?: { l2p?: (value: number) => number }[] };
    const axis = yaxes?.[0];
    const cursor = event.yvals?.[0];
    if (!axis?.l2p || typeof cursor !== 'number') {
      return;
    }
    const toPixel = axis.l2p;
    let nearest: string | null = null;
    let nearestDistance = HIGHLIGHT_DISTANCE_PX;
    event.points.forEach((point) => {
      const uid = (point.data as { uid?: string }).uid;
      if (!uid || FIXED_TRACES.has(uid) || typeof point.y !== 'number') {
        return;
      }
      const distance = Math.abs(toPixel(point.y) - toPixel(cursor));
      if (distance < nearestDistance) {
        nearest = uid;
        nearestDistance = distance;
      }
    });
    setHighlighted(nearest);
  };

  // Plotly has no legend hover event: listen on the legend items (g.traces,
  // whose d3 data holds the trace).
  const [graphDiv, setGraphDiv] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    if (!graphDiv) {
      return undefined;
    }
    const legendTrace = (target: EventTarget | null) => {
      const item = target instanceof Element ? target.closest('.legend .traces') : null;
      const uid = (item as { __data__?: [{ trace?: { uid?: string } }] } | null)?.__data__?.[0]
        ?.trace?.uid;
      return uid && !FIXED_TRACES.has(uid) ? uid : null;
    };
    const onOver = (event: MouseEvent) => {
      const uid = legendTrace(event.target);
      if (uid) {
        setHighlighted(uid);
      }
    };
    const onOut = (event: MouseEvent) => {
      if (legendTrace(event.target) && !legendTrace(event.relatedTarget)) {
        setHighlighted(null);
      }
    };
    graphDiv.addEventListener('mouseover', onOver);
    graphDiv.addEventListener('mouseout', onOut);
    return () => {
      graphDiv.removeEventListener('mouseover', onOver);
      graphDiv.removeEventListener('mouseout', onOut);
    };
  }, [graphDiv]);

  const content = (
    <>
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

      {frameSlider && frames.length > 0 && (
        <FrameSlider
          id="measurement-compare-timestamp"
          timestamps={sliderTimestamps}
          index={frameIndex}
          onChange={(index) => setSelectedId(frames[index]?.id ?? null)}
          playKey={sliderPlayKey}
        />
      )}

      <Plot
        data={data}
        onInitialized={(_, graphDiv) => setGraphDiv(graphDiv as HTMLElement)}
        onHover={highlightNearestLine}
        onUnhover={() => setHighlighted(null)}
        onLegendClick={(event) => !FIXED_TRACES.has(event.data[event.curveNumber]?.uid ?? '')}
        useResizeHandler
        style={{ width: '100%', height: '520px' }}
        config={{
          responsive: true,
          displaylogo: false,
          scrollZoom: true,
        }}
        layout={{
          autosize: true,
          margin: { l: 56, r: 16, t: frameSlider ? 56 : 16, b: 52 },
          font: { color: plotTheme.brandBlue },
          plot_bgcolor: plotTheme.warmGray1,
          paper_bgcolor: plotTheme.white,
          // Keeps zoom and legend toggles while the slider redraws the
          // plot; new rows reset them.
          uirevision: `${rows.length}:${rows[0]?.id}:${rows[rows.length - 1]?.id}`,
          shapes,
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
            zeroline: true,
          },
          xaxis2: {
            type: 'date',
            title: t('measurement_compare_measurement_datetime_label'),
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
            ...(frameSlider
              ? { y: 1.02, yanchor: 'bottom' as const }
              : { y: -0.25 }),
            x: 0,
            // A double click would isolate a line - hiding the fixed ones.
            itemdoubleclick: false,
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
    </>
  );

  if (hideChrome) {
    return content;
  }
  return (
    <Card className="border-0 shadow-sm p-3">
      <Card.Body>{content}</Card.Body>
    </Card>
  );
};

export default MeasurementSamplesCompareChart;
