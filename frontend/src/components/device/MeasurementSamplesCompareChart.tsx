import React from 'react';
import { Button, Card } from 'react-bootstrap';
import Plot from 'react-plotly.js';
import { useTranslation } from 'react-i18next';
import { parseTimestamp } from '../../main/alarmUtils';
import { plotTheme } from '../../styles/plotTheme';
import { formatDate } from '../../main/dateFormat';
import FrameSlider, { frameAt } from './FrameSlider';
import MeasurementCompareTooltip, {
  type CompareTooltipData,
  TOOLTIP_WIDTH,
} from './MeasurementCompareTooltip';

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
  /** EP / WP by sensor - empty without samples. */
  ep: number[];
  wp: number[];
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
  /**
   * Couples the time slider with another one (the heatmap's): it shows the
   * measurement at `time` (epoch ms; the newest while null) and reports the
   * time picked here to `onTimeChange` instead of keeping it itself.
   */
  time?: number | null;
  onTimeChange?: (ms: number) => void;
  /** Skip the component's own Card chrome so it can sit inside another panel wrapper. */
  hideChrome?: boolean;
};

/** The bands: never highlighted. */
const BAND_TRACES = new Set(['min-max', 'min-max-lower', 'deviation', 'deviation-lower']);

/** Traces a legend click doesn't hide. */
const FIXED_TRACES = new Set([...BAND_TRACES, 'pair-sum']);

/** Lines that start hidden, shown by a legend click. */
const OPTIONAL_TRACES = new Set(['ep+wp', 'wp-ep', 'pair-sum-diff']);

const MIN_MAX_COLOR = 'rgba(153, 27, 27, 0.25)';
const DEVIATION_COLOR = 'rgba(252, 122, 46, 0.31)';
const EDGE_COLOR = 'rgba(0, 0, 0, 0)';

/** Plotly visibility of an optional line: shown or only in the legend. */
const visibility = (shown: ReadonlySet<string>, uid: string) => ({
  visible: shown.has(uid) ? (true as const) : ('legendonly' as const),
});

const formatValue = (value: number) => value.toFixed(2);
const formatSigned = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}`;

/** Paper heights of the three plots: by sensor, the selected sensors over time, the sensor sum. */
const UPPER_DOMAIN: [number, number] = [0.6, 1];
const SENSORS_DOMAIN: [number, number] = [0.27, 0.48];
const SUM_DOMAIN: [number, number] = [0, 0.17];

/** The two time plots (shared, matched time axis) and their heights. */
const TIME_PLOTS: [string, [number, number]][] = [
  ['x3', SENSORS_DOMAIN],
  ['x2', SUM_DOMAIN],
];

const SENSOR_COLORS = [
  plotTheme.brandBlue,
  plotTheme.brandOrange,
  plotTheme.contrastGreen,
  plotTheme.contrastViolet,
  plotTheme.contrastCyan,
  plotTheme.contrastYellow,
  '#6b6b6b',
];

/** A selected sensor's colour - by its index, so it keeps it while others come and go. */
const sensorColor = (sensor: number) => SENSOR_COLORS[sensor % SENSOR_COLORS.length];

/** A dotted line across the plot at the hovered x. */
const SPIKE = {
  showspikes: true,
  spikemode: 'across' as const,
  spikesnap: 'cursor' as const,
  spikethickness: 1,
  spikedash: 'dot',
  spikecolor: plotTheme.warmGray4,
};

/** What the tooltip reads of a hovered point's trace. */
type HoverTrace = {
  uid?: string;
  name?: string;
  xaxis?: string;
  line?: { color?: string };
  fillcolor?: string;
};

/** What onRelayout reads of Plotly's full (internal) axis. */
type PlotlyFullAxis = {
  range?: [unknown, unknown];
  r2l?: (value: unknown) => number;
  autorange?: boolean | string;
};

/** The full axis Plotly passes with hover points (the typings lack l2p). */
type PixelAxis = { l2p?: (value: number) => number };

/** How close (px) the cursor must be to a line to highlight it. */
const HIGHLIGHT_DISTANCE_PX = 12;

/** The tooltip's distance (px) from the plot's top corner. */
const TOOLTIP_INSET_PX = 8;

/** How close (px) the cursor may come to the tooltip before it moves to the other side. */
const TOOLTIP_FLIP_DISTANCE_PX = 24;

/** The click hint's distance (px) from the cursor, right below it. */
const HINT_OFFSET_PX = 14;

/** Puts the click hint next to the cursor (px within the chart) - left of
 * it where the chart ends. */
const placeHint = (hint: HTMLElement | null, cursor: { x: number; y: number } | null) => {
  if (hint && cursor) {
    const fits = cursor.x + HINT_OFFSET_PX + hint.offsetWidth <= (hint.parentElement?.clientWidth ?? 0);
    hint.style.left = `${fits ? cursor.x + HINT_OFFSET_PX : cursor.x - HINT_OFFSET_PX - hint.offsetWidth}px`;
    hint.style.top = `${cursor.y + HINT_OFFSET_PX}px`;
  }
};

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
    time = null,
    onTimeChange,
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
  // Coupled (onTimeChange): the measurement at `time`.
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const selectedIndex = onTimeChange
    ? time == null
      ? -1
      : frameAt(sliderTimestamps, time)
    : frames.findIndex((frame) => frame.id === selectedId);
  const frameIndex = selectedIndex >= 0 ? selectedIndex : frames.length - 1;
  const currentFrame = frames[frameIndex] ?? null;
  const selectFrame = (index: number) => {
    const frame = frames[index];
    if (!frame) {
      return;
    }
    if (onTimeChange) {
      onTimeChange(frame.ms);
    } else {
      setSelectedId(frame.id);
    }
  };

  const series: DiffSeries[] = React.useMemo(
    () =>
      rows.map((row) => ({
        id: row.id,
        lastFetched: row.last_fetched,
        points: toPairAbsDiff(row.samples, row.pair_abs_values),
        ...toPotentials(row.samples),
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
    const minimums: number[] = [];
    const maximums: number[] = [];

    series.forEach((entry) => {
      entry.points.forEach((point) => {
        const index = point.pairIndex;
        minimums[index] = Math.min(minimums[index] ?? point.value, point.value);
        maximums[index] = Math.max(maximums[index] ?? point.value, point.value);
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
    const min: number[] = [];
    const max: number[] = [];

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
      min.push(minimums[index]);
      max.push(maximums[index]);
    });

    return { x, mean, upper, lower, sigma, min, max };
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
    // Per measurement: its id (a click moves the slider to it), its
    // |EP - WP| by sensor (the selected sensors' plot) and its EP / WP by
    // sensor (the tooltip of a hovered sensor line).
    const ids: number[] = [];
    const pairs: number[][] = [];
    const potentials: { ep: number[]; wp: number[] }[] = [];
    orderedSeries.forEach((entry) => {
      const ts = parseTimestamp(entry.lastFetched);
      if (ts == null) {
        return; // cannot be placed on the date axis
      }
      x.push(ts);
      y.push(entry.points.reduce((acc, point) => acc + point.value, 0));
      measurementDateTime.push(formatDate(entry.lastFetched, 'dateTimeSeconds'));
      ids.push(entry.id);
      pairs.push(entry.points.map((point) => point.value));
      potentials.push({ ep: entry.ep, wp: entry.wp });
    });
    // Change of the sum since the previous measurement (none for the first).
    const diff = y.map((value, index) => (index > 0 ? value - y[index - 1] : null));

    return { x, y, diff, measurementDateTime, ids, pairs, potentials };
  }, [series]);

  // Sensors (pair index) whose values over time the second plot shows - a
  // click on the first plot adds or removes one.
  const [selectedSensors, setSelectedSensors] = React.useState<number[]>([]);
  const toggleSensor = (sensor: number) =>
    setSelectedSensors((selected) =>
      selected.includes(sensor)
        ? selected.filter((entry) => entry !== sensor)
        : [...selected, sensor].sort((a, b) => a - b),
    );

  const sensorTraces = React.useMemo(() => {
    if (!selectedSensors.length) {
      // Keeps the (empty) plot with its hint.
      return [
        {
          type: 'scatter' as const,
          mode: 'lines' as const,
          uid: 'sensor-none',
          name: '',
          x: [] as number[],
          y: [] as number[],
          xaxis: 'x3' as const,
          yaxis: 'y4' as const,
          line: { color: EDGE_COLOR, width: 1 },
          hoverinfo: 'skip' as const,
          showlegend: false,
        },
      ];
    }
    return selectedSensors.map((sensor) => ({
      type: 'scatter' as const,
      mode: 'lines' as const,
      uid: `sensor-${sensor}`,
      name: `${t('measurement_compare_pair_label')} ${sensor}`,
      x: pairSumSeries.x,
      y: pairSumSeries.pairs.map((values) => values[sensor] ?? null),
      xaxis: 'x3' as const,
      yaxis: 'y4' as const,
      // Their own legend, at the second plot.
      legend: 'legend2',
      line: { color: sensorColor(sensor), width: 2 },
      hoverinfo: 'none' as const,
    }));
  }, [selectedSensors, pairSumSeries, t]);

  // EP + WP, WP - EP and the sum difference start hidden; a legend click
  // shows them. Kept here, not by Plotly: they widen the locked y-axis or
  // need their own axis.
  const [shownOptional, setShownOptional] = React.useState<ReadonlySet<string>>(new Set());
  const toggleOptional = (uid: string) =>
    setShownOptional((shown) => {
      const next = new Set(shown);
      if (!next.delete(uid)) {
        next.add(uid);
      }
      return next;
    });
  const showSumDiff = shownOptional.has('pair-sum-diff');

  // All plain scatter (not scattergl): a highlight (width, opacity) then
  // only restyles. No Plotly hover labels - the values go to the tooltip.
  const traces = React.useMemo(() => {
    // A band: the transparent upper edge, then the lower edge filling up to
    // it - the filled one carries the legend entry (with its colour).
    const band = (uid: string, name: string, upper: number[], lower: number[], color: string) => [
      {
        type: 'scatter' as const,
        mode: 'lines' as const,
        uid,
        name,
        x: meanAndDeviationSeries.x,
        y: upper,
        line: { color: EDGE_COLOR, width: 1 },
        hoverinfo: 'skip' as const,
        showlegend: false,
      },
      {
        type: 'scatter' as const,
        mode: 'lines' as const,
        uid: `${uid}-lower`,
        name,
        x: meanAndDeviationSeries.x,
        y: lower,
        line: { color: EDGE_COLOR, width: 1 },
        fill: 'tonexty' as const,
        fillcolor: color,
        hoverinfo: 'none' as const,
      },
    ];
    return [
      ...band(
        'min-max',
        t('measurement_compare_min_max_label'),
        meanAndDeviationSeries.max,
        meanAndDeviationSeries.min,
        MIN_MAX_COLOR,
      ),
      ...band(
        'deviation',
        t('measurement_compare_deviation_label'),
        meanAndDeviationSeries.upper,
        meanAndDeviationSeries.lower,
        DEVIATION_COLOR,
      ),
      {
        type: 'scatter' as const,
        mode: 'lines' as const,
        uid: 'mean',
        name: t('measurement_compare_mean_label'),
        x: meanAndDeviationSeries.x,
        y: meanAndDeviationSeries.mean,
        line: {
          color: plotTheme.brandBlue,
          width: 4,
        },
        hoverinfo: 'none' as const,
      },
      {
        type: 'scatter' as const,
        mode: 'lines' as const,
        uid: 'pair-sum',
        name: t('measurement_compare_pair_sum_label'),
        x: pairSumSeries.x,
        y: pairSumSeries.y,
        xaxis: 'x2' as const,
        yaxis: 'y2' as const,
        line: {
          color: 'rgba(44, 160, 44, 0.95)',
          width: 3,
        },
        hoverinfo: 'none' as const,
      },
      {
        type: 'scatter' as const,
        mode: 'lines' as const,
        uid: 'pair-sum-diff',
        name: t('measurement_compare_pair_sum_diff_label'),
        x: pairSumSeries.x,
        y: pairSumSeries.diff,
        xaxis: 'x2' as const,
        // Own axis (right): far smaller than the sum and signed.
        yaxis: 'y3' as const,
        line: {
          color: plotTheme.contrastViolet,
          width: 2,
        },
        hoverinfo: 'none' as const,
        ...visibility(shownOptional, 'pair-sum-diff'),
      },
    ];
  }, [meanAndDeviationSeries, pairSumSeries, shownOptional, t]);

  // The slider's measurement on the upper plot. Fixed uids keep the legend
  // toggles while sliding.
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
      hoverinfo: 'none' as const,
      ...(optional ? visibility(shownOptional, uid) : {}),
    });
    return [
      line('ep-wp', 'EP − WP', ep.map((value, i) => value - wp[i]), 'orange', 3),
      line('ep', 'EP', ep, 'red', 2),
      line('wp', 'WP', wp, 'blue', 2),
      line('ep+wp', 'EP + WP', ep.map((value, i) => value + wp[i]), plotTheme.contrastViolet, 2, true),
      line('wp-ep', 'WP − EP', wp.map((value, i) => value - ep[i]), plotTheme.contrastCyan, 2, true),
    ];
  }, [currentFrame, shownOptional]);

  // The upper y-axis is locked to the lines of all measurements of the
  // slider - low (negative) as well as high - autorange would rescale
  // (flicker) with every step.
  const upperRange = React.useMemo((): [number, number] | null => {
    if (!frames.length) {
      return null;
    }
    let low = 0;
    let high = 0;
    const include = (value: number) => {
      low = Math.min(low, value);
      high = Math.max(high, value);
    };
    meanAndDeviationSeries.upper.forEach(include);
    meanAndDeviationSeries.max.forEach(include);
    frames.forEach(({ ep, wp }) => {
      ep.forEach((value, i) => {
        include(value);
        include(wp[i]);
        include(value - wp[i]);
        if (shownOptional.has('ep+wp')) {
          include(value + wp[i]);
        }
        if (shownOptional.has('wp-ep')) {
          include(wp[i] - value);
        }
      });
    });
    if (high <= low) {
      return null;
    }
    const padding = (high - low) * 0.05;
    return [low < 0 ? low - padding : 0, high + padding];
  }, [frames, meanAndDeviationSeries, shownOptional]);

  const shapes = React.useMemo(() => {
    const result: Partial<Plotly.Shape>[] = [];
    // The selected sensors, marked on the first plot in their colour.
    selectedSensors.forEach((sensor) => {
      result.push({
        type: 'rect',
        layer: 'below',
        xref: 'x',
        yref: 'paper',
        x0: sensor - 0.5,
        x1: sensor + 0.5,
        y0: UPPER_DOMAIN[0],
        y1: UPPER_DOMAIN[1],
        fillcolor: sensorColor(sensor),
        opacity: 0.18,
        line: { width: 0 },
      });
    });
    // The alarm and the slider's time on both time plots.
    TIME_PLOTS.forEach(([xref, [y0, y1]]) => {
      const onPlot = { xref: xref as Plotly.XAxisName, yref: 'paper' as const, y0, y1 };
      if (alarmBandX != null) {
        result.push(
          alarmBandX.end > alarmBandX.start
            ? {
                ...onPlot,
                type: 'rect',
                x0: alarmBandX.start,
                x1: alarmBandX.end,
                fillcolor: 'rgba(220, 38, 38, 0.22)',
                line: { width: 0 },
              }
            : {
                ...onPlot,
                type: 'line',
                x0: alarmBandX.start,
                x1: alarmBandX.start,
                line: {
                  color: 'rgba(220, 38, 38, 0.6)',
                  width: 2,
                },
              },
        );
      }
      if (currentFrame) {
        result.push({
          ...onPlot,
          type: 'line',
          x0: currentFrame.ms,
          x1: currentFrame.ms,
          line: { color: 'orange', width: 2, dash: 'dot' },
        });
      }
    });
    return result;
  }, [alarmBandX, currentFrame, selectedSensors]);

  // The line under the cursor or its legend entry is highlighted: wider,
  // the other lines of its plot faded. The bands stay as they are.
  const [highlighted, setHighlighted] = React.useState<string | null>(null);
  const data = React.useMemo(() => {
    const all = [...traces, ...currentTraces, ...sensorTraces];
    const subplot = (trace: (typeof all)[number] | undefined) =>
      trace && 'xaxis' in trace ? trace.xaxis : 'x';
    const highlightedTrace = all.find((trace) => trace.uid === highlighted);
    if (!highlightedTrace) {
      return all;
    }
    return all.map((trace) => {
      if (BAND_TRACES.has(trace.uid) || subplot(trace) !== subplot(highlightedTrace)) {
        return trace;
      }
      return trace === highlightedTrace
        ? { ...trace, line: { ...trace.line, width: trace.line.width + 2 } }
        : { ...trace, opacity: 0.3 };
    });
  }, [traces, currentTraces, sensorTraces, highlighted]);

  // In 'x unified' hover every line reports its point at the cursor's x: the
  // nearest one within HIGHLIGHT_DISTANCE_PX is the hovered line. Compared
  // in pixels - the lower plot's lines have an axis each.
  const nearestLine = (event: Readonly<Plotly.PlotHoverEvent>) => {
    // Plotly passes the hovered subplot's axes too, the typings lack them.
    const { yaxes } = event as { yaxes?: PixelAxis[] };
    const cursor = event.yvals?.[0];
    const cursorPixel = typeof cursor === 'number' ? yaxes?.[0]?.l2p?.(cursor) : undefined;
    if (cursorPixel == null) {
      return null;
    }
    let nearest: string | null = null;
    let nearestDistance = HIGHLIGHT_DISTANCE_PX;
    event.points.forEach((point) => {
      const uid = (point.data as { uid?: string }).uid;
      const toPixel = (point.yaxis as unknown as PixelAxis | undefined)?.l2p;
      if (!uid || BAND_TRACES.has(uid) || typeof point.y !== 'number' || !toPixel) {
        return;
      }
      const distance = Math.abs(toPixel(point.y) - cursorPixel);
      if (distance < nearestDistance) {
        nearest = uid;
        nearestDistance = distance;
      }
    });
    return nearest;
  };

  // The values at the cursor's x, shown in a corner of the plot.
  const [tooltip, setTooltip] = React.useState<CompareTooltipData | null>(null);
  const tooltipOf = (
    event: Readonly<Plotly.PlotHoverEvent>,
    hovered: string | null,
  ): CompareTooltipData | null => {
    const points = [...event.points].sort((a, b) => a.curveNumber - b.curveNumber);
    if (!points.length) {
      return null;
    }
    // The sensor line whose EP and WP are added: the hovered one, else the
    // only one there is.
    const detailed =
      hovered?.startsWith('sensor-')
        ? hovered
        : selectedSensors.length === 1
          ? `sensor-${selectedSensors[0]}`
          : null;
    const potentialRows = (uid: string, index: number) => {
      const sensor = Number(uid.slice('sensor-'.length));
      const { ep, wp } = pairSumSeries.potentials[index] ?? { ep: [], wp: [] };
      if (ep[sensor] == null || wp[sensor] == null) {
        return [];
      }
      const of = `(${t('measurement_compare_pair_label')} ${sensor})`;
      return [
        { key: `${uid}-ep`, name: `EP ${of}`, color: 'red', value: formatValue(ep[sensor]) },
        { key: `${uid}-wp`, name: `WP ${of}`, color: 'blue', value: formatValue(wp[sensor]) },
      ];
    };
    const rows = points.flatMap((point) => {
      const trace = point.data as HoverTrace;
      const uid = trace.uid ?? '';
      const index = point.pointIndex;
      const row = { key: uid, name: String(trace.name ?? ''), color: String(trace.line?.color ?? '') };
      if (uid === 'min-max-lower' || uid === 'deviation-lower') {
        const [low, high] =
          uid === 'min-max-lower'
            ? [meanAndDeviationSeries.min[index], meanAndDeviationSeries.max[index]]
            : [meanAndDeviationSeries.lower[index], meanAndDeviationSeries.upper[index]];
        return [{ ...row, color: String(trace.fillcolor), band: true, value: `${formatValue(low)} – ${formatValue(high)}` }];
      }
      if (typeof point.y !== 'number') {
        return [];
      }
      if (uid === 'mean') {
        const sigma = meanAndDeviationSeries.sigma[index];
        return [{ ...row, value: `${formatValue(point.y)} (${t('measurement_compare_sigma_label')} ${formatValue(sigma)})` }];
      }
      if (uid === detailed) {
        return [{ ...row, value: formatValue(point.y) }, ...potentialRows(uid, index)];
      }
      return [{ ...row, value: uid === 'pair-sum-diff' ? formatSigned(point.y) : formatValue(point.y) }];
    });
    const first = points[0];
    const firstAxis = (first.data as HoverTrace).xaxis;
    if (firstAxis === 'x2' || firstAxis === 'x3') {
      return { title: pairSumSeries.measurementDateTime[first.pointIndex] ?? '', rows };
    }
    return {
      title: `${t('measurement_compare_pair_label')} ${first.x}`,
      // The time of the slider's measurement (EP / WP lines).
      subtitle: currentFrame
        ? `${t('measurement_compare_measurement_datetime_label')}: ${formatDate(currentFrame.ms, 'dateTimeSeconds')}`
        : null,
      rows,
    };
  };

  // The sensor under the cursor on the first plot - a small hint at the
  // cursor tells that a click follows it (or stops it) on the second plot.
  const [hoveredSensor, setHoveredSensor] = React.useState<number | null>(null);

  const onHover = (event: Readonly<Plotly.PlotHoverEvent>) => {
    const nearest = nearestLine(event);
    setHighlighted(nearest);
    setTooltip(tooltipOf(event, nearest));
    const first = event.points[0];
    const onFirstPlot = first && !(first.data as HoverTrace).xaxis;
    setHoveredSensor(onFirstPlot && typeof first.x === 'number' ? first.x : null);
  };
  const onUnhover = () => {
    setHighlighted(null);
    setTooltip(null);
    setHoveredSensor(null);
  };

  const margin = { l: 64, r: showSumDiff ? 64 : 16, t: frameSlider ? 56 : 16, b: 52 };

  // The tooltip sits top right - top left while the cursor comes near it,
  // so it never covers what is hovered. Both follow the cursor without a
  // re-render (the plot would redraw): the hint by its style, the side only
  // when it changes.
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const tooltipRef = React.useRef<HTMLDivElement | null>(null);
  const hintRef = React.useRef<HTMLDivElement | null>(null);
  const cursorRef = React.useRef<{ x: number; y: number } | null>(null);
  const [tooltipLeft, setTooltipLeft] = React.useState(false);
  const onMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const wrap = wrapRef.current;
    if (!wrap) {
      return;
    }
    const box = wrap.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    cursorRef.current = { x, y };
    placeHint(hintRef.current, cursorRef.current);
    // Near the tooltip's place on the right (with its current height).
    const right = box.width - margin.r - TOOLTIP_INSET_PX;
    const bottom = margin.t + TOOLTIP_INSET_PX + (tooltipRef.current?.offsetHeight ?? 0);
    setTooltipLeft(
      x >= right - TOOLTIP_WIDTH - TOOLTIP_FLIP_DISTANCE_PX && y <= bottom + TOOLTIP_FLIP_DISTANCE_PX,
    );
  };
  // Placed as soon as it appears, not only with the next move.
  React.useLayoutEffect(() => placeHint(hintRef.current, cursorRef.current), [hoveredSensor]);

  // The selected sensors' legend: right above the second plot. Spread into
  // the layout - the typings know only one legend.
  const sensorLegend = {
    legend2: {
      orientation: 'h' as const,
      x: 1,
      xanchor: 'right' as const,
      y: SENSORS_DOMAIN[1],
      yanchor: 'bottom' as const,
      itemdoubleclick: false as const,
      bgcolor: plotTheme.warmGray1,
      bordercolor: plotTheme.warmGray3,
      borderwidth: 1,
    },
  };

  // Plotly has no legend hover event: listen on the legend items (g.traces,
  // whose d3 data holds the trace).
  const [graphDiv, setGraphDiv] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    if (!graphDiv) {
      return undefined;
    }
    const legendTrace = (target: EventTarget | null) => {
      const item = target instanceof Element ? target.closest('.legend .traces, .legend2 .traces') : null;
      const uid = (item as { __data__?: [{ trace?: { uid?: string } }] } | null)?.__data__?.[0]
        ?.trace?.uid;
      return uid && !BAND_TRACES.has(uid) ? uid : null;
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

  // A click on the first plot adds or removes that sensor in the second; one
  // on a time plot moves the slider to that measurement.
  const onClick = (event: Readonly<Plotly.PlotMouseEvent>) => {
    const point = event.points[0];
    if (!point) {
      return;
    }
    const xaxis = (point.data as HoverTrace).xaxis;
    if (xaxis === 'x2' || xaxis === 'x3') {
      const id = pairSumSeries.ids[point.pointIndex];
      selectFrame(frames.findIndex((frame) => frame.id === id));
      return;
    }
    if (typeof point.x === 'number') {
      toggleSensor(point.x);
    }
  };

  // Keeps zoom and legend toggles while the slider redraws the plot; new
  // rows reset them.
  const uiRevision = `${rows.length}:${rows[0]?.id}:${rows[rows.length - 1]?.id}`;

  // The time span the time plots show (zoomed, else all frames) - a band on
  // the slider. Read from Plotly's own axis: its range in ms, whichever of
  // the matched time axes was zoomed.
  const [zoom, setZoom] = React.useState<{ revision: string; from: number; to: number } | null>(null);
  const onRelayout = () => {
    const axis = (graphDiv as { _fullLayout?: { xaxis2?: PlotlyFullAxis } } | null)?._fullLayout?.xaxis2;
    if (!axis?.r2l || !axis.range) {
      return;
    }
    setZoom(
      axis.autorange
        ? null
        : { revision: uiRevision, from: axis.r2l(axis.range[0]), to: axis.r2l(axis.range[1]) },
    );
  };
  const visibleRange =
    zoom?.revision === uiRevision
      ? zoom
      : frames.length
        ? { from: frames[0].ms, to: frames[frames.length - 1].ms }
        : null;

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
          onChange={selectFrame}
          playKey={sliderPlayKey}
          visibleRange={visibleRange}
        />
      )}

      <div ref={wrapRef} style={{ position: 'relative' }} onMouseMove={onMouseMove}>
        {tooltip && (
          // Top right of the upper plot - top left while the cursor is near.
          <MeasurementCompareTooltip
            ref={tooltipRef}
            tooltip={tooltip}
            activeKey={highlighted}
            style={
              tooltipLeft
                ? { top: margin.t + TOOLTIP_INSET_PX, left: margin.l + TOOLTIP_INSET_PX }
                : { top: margin.t + TOOLTIP_INSET_PX, right: margin.r + TOOLTIP_INSET_PX }
            }
          />
        )}
        {hoveredSensor != null && (
          <div
            ref={hintRef}
            className="position-absolute bg-dark text-white rounded px-2 py-1 text-nowrap"
            style={{ pointerEvents: 'none', zIndex: 3, fontSize: 11, opacity: 0.85 }}
          >
            {t(
              selectedSensors.includes(hoveredSensor)
                ? 'measurement_compare_sensor_click_remove'
                : 'measurement_compare_sensor_click_add',
              { sensor: hoveredSensor },
            )}
          </div>
        )}
        <Plot
          data={data}
          onInitialized={(_, graphDiv) => setGraphDiv(graphDiv as HTMLElement)}
          onHover={onHover}
          onUnhover={onUnhover}
          onClick={onClick}
          onRelayout={onRelayout}
          onLegendClick={(event) => {
            const uid = event.data[event.curveNumber]?.uid ?? '';
            if (uid.startsWith('sensor-')) {
              // A selected sensor's entry removes it from the second plot.
              toggleSensor(Number(uid.slice('sensor-'.length)));
              return false;
            }
            if (OPTIONAL_TRACES.has(uid)) {
              toggleOptional(uid);
              return false;
            }
            return !FIXED_TRACES.has(uid);
          }}
          useResizeHandler
          style={{ width: '100%', height: '800px' }}
          config={{
            responsive: true,
            displaylogo: false,
            scrollZoom: true,
          }}
          layout={{
            autosize: true,
            margin,
            font: { color: plotTheme.brandBlue },
            plot_bgcolor: plotTheme.warmGray1,
            paper_bgcolor: plotTheme.white,
            uirevision: uiRevision,
            shapes,
            annotations: selectedSensors.length
              ? []
              : [
                  {
                    xref: 'paper',
                    yref: 'paper',
                    x: 0.5,
                    y: (SENSORS_DOMAIN[0] + SENSORS_DOMAIN[1]) / 2,
                    text: t('measurement_compare_sensor_hint'),
                    showarrow: false,
                    opacity: 0.7,
                  },
                ],
            xaxis: {
              title: { text: t('measurement_compare_pair_index_axis') },
              domain: [0, 1],
              anchor: 'y',
              showgrid: true,
              gridcolor: plotTheme.warmGray2,
              zeroline: false,
              ...SPIKE,
            },
            yaxis: {
              title: { text: t('measurement_compare_absolute_delta_axis') },
              domain: UPPER_DOMAIN,
              rangemode: 'tozero',
              // Also after a double click / autoscale, which turns autorange
              // back on: it then still spans all measurements.
              ...(upperRange
                ? { range: upperRange, autorange: false, autorangeoptions: { include: upperRange } }
                : {}),
              showgrid: true,
              gridcolor: plotTheme.warmGray2,
              zeroline: true,
            },
            xaxis2: {
              type: 'date',
              title: { text: t('measurement_compare_measurement_datetime_label') },
              domain: [0, 1],
              anchor: 'y2',
              showgrid: true,
              gridcolor: plotTheme.warmGray2,
              zeroline: false,
              ...SPIKE,
            },
            yaxis2: {
              title: { text: t('measurement_compare_pair_sum_axis') },
              domain: SUM_DOMAIN,
              side: 'left',
              showgrid: true,
              gridcolor: plotTheme.warmGray2,
              zeroline: false,
            },
            // The selected sensors over time - zoomed together with the sum.
            xaxis3: {
              type: 'date',
              matches: 'x2',
              domain: [0, 1],
              anchor: 'y4',
              showgrid: true,
              gridcolor: plotTheme.warmGray2,
              zeroline: false,
              ...SPIKE,
            },
            yaxis4: {
              title: { text: t('measurement_compare_absolute_delta_axis') },
              domain: SENSORS_DOMAIN,
              anchor: 'x3',
              rangemode: 'tozero',
              showgrid: true,
              gridcolor: plotTheme.warmGray2,
              zeroline: true,
            },
            yaxis3: {
              visible: showSumDiff,
              title: { text: t('measurement_compare_pair_sum_diff_label') },
              overlaying: 'y2',
              side: 'right',
              anchor: 'x2',
              showgrid: false,
              zeroline: true,
              zerolinecolor: plotTheme.warmGray4,
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
            ...sensorLegend,
            hovermode: 'x unified',
          }}
        />
      </div>
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
