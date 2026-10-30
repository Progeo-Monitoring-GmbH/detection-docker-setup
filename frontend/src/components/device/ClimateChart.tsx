import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Plot from 'react-plotly.js';
import Plotly from 'plotly.js/dist/plotly';
import { plotTheme } from '../../styles/plotTheme';
import { formatDate } from '../../main/dateFormat';

/** One device of GET /v1/location/<pk>/climate/ - aligned series, oldest first. */
export type ClimateDeviceSeries = {
  id: number;
  label: string;
  type: string | null;
  /** Epoch seconds. */
  timestamps: number[];
  humidity: Array<number | null>;
  temperature: Array<number | null>;
  /** Battery level in percent. */
  battery: Array<number | null>;
  /** Battery voltage in V (IMEI devices). */
  battery_v: Array<number | null>;
};

export type ClimateResponse = {
  days: number;
  /** Long ranges (days > 31) are averaged into buckets of this many seconds -
   * one value per bucket, timestamps = bucket start. null/absent: raw data. */
  bucket_seconds?: number | null;
  devices: ClimateDeviceSeries[];
};

export type ClimateMetric = 'humidity' | 'temperature' | 'battery' | 'battery_v';

// Temperature reads warm, humidity cool, battery green. The shades vary in
// hue as well as lightness so neighbouring devices stay apart. A device
// keeps its index in every chart, so it is the n-th red, blue and green.
// Lines are always solid; beyond the fixed shades more are generated (see
// deviceColor).
const BATTERY_COLORS = [
  '#2E7D32', '#9E9D24', '#00695C', '#66BB6A', '#33691E', '#AFB42B',
  '#558B2F', '#004D40', '#7CB342', '#827717', '#43A047', '#1B5E20',
];
const METRIC_COLORS: Record<ClimateMetric, string[]> = {
  temperature: [
    '#C62828', '#EF6C00', '#AD1457', '#D9605A', '#7B1F12', '#E8913A',
    '#F9A825', '#8E24AA', '#BF360C', '#FF7043', '#6D4C41', '#E91E63',
  ],
  humidity: [
    '#1565C0', '#00838F', '#5E35B1', '#4A9BE0', '#0D2F6B', '#2BA3B5',
    '#2E7D32', '#3949AB', '#0277BD', '#26A69A', '#6A1B9A', '#00ACC1',
  ],
  battery: BATTERY_COLORS,
  battery_v: BATTERY_COLORS,
};
// Hue ranges of the generated shades: warm (reds/oranges), cool
// (blues/cyans) and greens.
const GENERATED_HUES: Record<ClimateMetric, [number, number]> = {
  temperature: [-20, 50],
  humidity: [160, 270],
  battery: [60, 150],
  battery_v: [60, 150],
};
// Battery levels are whole percents, voltages mV-exact; the climate values
// keep two decimals.
const VALUE_FORMAT: Record<ClimateMetric, string> = {
  temperature: '.2f',
  humidity: '.2f',
  battery: '.0f',
  battery_v: '.3f',
};

const deviceColor = (metric: ClimateMetric, index: number): string => {
  const colors = METRIC_COLORS[metric];
  if (index < colors.length) {
    return colors[index];
  }
  const extra = index - colors.length;
  const [from, to] = GENERATED_HUES[metric];
  // Golden-angle steps spread hue and lightness so consecutive shades differ.
  const hue = (from + ((extra * 137.5) % (to - from)) + 360) % 360;
  const lightness = 32 + ((extra * 17) % 30);
  return `hsl(${hue.toFixed(0)}, 65%, ${lightness}%)`;
};

const MUTED_TEXT = '#8B8383';
// The mean over all devices.
const OVERALL_MEAN_COLOR = '#9E9696';

// One revision number per computed trace set (see Plot's revision prop).
const revisions = new WeakMap<object, number>();
let revisionCounter = 0;
const revisionOf = (traces: object): number => {
  let revision = revisions.get(traces);
  if (revision === undefined) {
    revision = ++revisionCounter;
    revisions.set(traces, revision);
  }
  return revision;
};
const DAY_MS = 24 * 60 * 60 * 1000;

// Device names are user-editable (mac) and end up in Plotly's pseudo-HTML.
const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type ClimateChartProps = {
  devices: ClimateDeviceSeries[];
  metric: ClimateMetric;
  axisTitle: string;
  unit: string;
  emptyLabel: string;
  height?: number;
  /** Device whose line is highlighted (shared between the charts). */
  hoveredDeviceId?: number | null;
  onHoverDevice?: (deviceId: number | null) => void;
  /** Bucket size of averaged data (ClimateResponse.bucket_seconds). */
  bucketSeconds?: number | null;
  /** Reference time (ms) the tooltips compare against - set by clicking a
   * point. Pass it with onReferenceChange to share it between charts;
   * without, the chart keeps its own. */
  referenceTime?: number | null;
  onReferenceChange?: (time: number | null) => void;
};

const GAIN_COLOR = '#3F7A1C';
const LOSS_COLOR = '#C44D26';
// A device's reference value is its reading nearest the reference time -
// none if that is further away than this (raw data) or one bucket (averaged).
const REFERENCE_TOLERANCE_MS = 3 * 60 * 60 * 1000;

/** Index of the timestamp (s) nearest `time` (ms) with a value, within `tolerance` ms. */
const nearestIndex = (
  timestamps: number[],
  values: Array<number | null>,
  time: number,
  tolerance: number,
): number | null => {
  let best: number | null = null;
  let bestDistance = Infinity;
  timestamps.forEach((ts, index) => {
    const distance = Math.abs(ts * 1000 - time);
    if (values[index] != null && distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best != null && bestDistance <= tolerance ? best : null;
};

const mean = (values: Array<number | null>): number | null => {
  const present = values.filter((value): value is number => value != null && Number.isFinite(value));
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
};

/**
 * Time series of one climate metric (humidity, temperature, battery or battery voltage), one line per
 * device of the location - a LoRaWAN object has several sensors. The mean over all devices is drawn as
 * a gray dashed line, a device's own mean only while it is hovered; clicking a point makes its time the
 * reference the tooltips compare against.
 */
const ClimateChart = ({
  devices,
  metric,
  axisTitle,
  unit,
  emptyLabel,
  height = 340,
  hoveredDeviceId = null,
  onHoverDevice,
  bucketSeconds = null,
  referenceTime: controlledReference,
  onReferenceChange,
}: ClimateChartProps) => {
  const { t } = useTranslation();
  const [ownReference, setOwnReference] = useState<number | null>(null);
  const controlled = onReferenceChange != null;
  const referenceTime = controlled ? (controlledReference ?? null) : ownReference;
  const setReference = controlled ? onReferenceChange : setOwnReference;

  // Averaged data: smaller markers (many evenly spaced points), the value
  // marked as a mean, and no time of day once a bucket spans a whole day.
  const averaged = bucketSeconds != null && bucketSeconds > 0;
  const dailyBuckets = averaged && bucketSeconds * 1000 >= DAY_MS;
  const hoverTime = dailyBuckets ? '%d.%m.%Y' : '%d.%m.%Y, %H:%M';
  const tolerance = averaged ? bucketSeconds * 1000 : REFERENCE_TOLERANCE_MS;
  const format = VALUE_FORMAT[metric];
  const decimals = Number(format.replace(/\D/g, '')) || 0;

  const baseTraces = useMemo(
    () =>
      devices
        // Index before filtering: a device's style follows the device, not
        // which other devices happen to have readings.
        .map((device, index) => ({ device, index }))
        .filter(({ device }) => device[metric].some((value) => value != null))
        .map(({ device, index }) => {
          const color = deviceColor(metric, index);
          const values = device[metric];
          const referenceIndex =
            referenceTime != null ? nearestIndex(device.timestamps, values, referenceTime, tolerance) : null;
          const reference = referenceIndex != null ? values[referenceIndex] : null;
          // Per point: the change against the device's reference value.
          const comparison = values.map((value, pointIndex) => {
            if (referenceTime == null) {
              return '';
            }
            if (pointIndex === referenceIndex) {
              return `<br><span style="color:${MUTED_TEXT}">${t('climate_reference_point')}</span>`;
            }
            if (value == null || reference == null || reference === 0) {
              return `<br><span style="color:${MUTED_TEXT}">${t('climate_reference_none')}</span>`;
            }
            const change = ((value - reference) / Math.abs(reference)) * 100;
            const sign = change > 0 ? '+' : change < 0 ? '−' : '±';
            const changeColor = change > 0 ? GAIN_COLOR : change < 0 ? LOSS_COLOR : MUTED_TEXT;
            return (
              `<br><span style="color:${changeColor}"><b>${sign}${Math.abs(change).toFixed(1)} %</b></span>` +
              ` <span style="color:${MUTED_TEXT}">${t('climate_reference_vs', {
                value: reference.toFixed(decimals),
                unit,
              })}</span>`
            );
          });
          return {
            deviceId: device.id,
            label: device.label,
            mean: mean(values),
            referenceIndex,
            type: 'scatter' as const,
            mode: 'lines+markers' as const,
            name: escapeHtml(device.label),
            x: device.timestamps.map((ts) => new Date(ts * 1000)),
            y: values,
            customdata: comparison,
            connectgaps: true,
            line: {
              color,
              width: 2,
            },
            marker: {
              // The reference point stands out: bigger, with a white ring.
              size: values.map((_, pointIndex) => (pointIndex === referenceIndex ? 11 : averaged ? 3 : 6)),
              color,
              line: {
                color: plotTheme.white,
                width: values.map((_, pointIndex) => (pointIndex === referenceIndex ? 2 : 0)),
              },
            },
            hoverlabel: { bordercolor: color },
            hovertemplate:
              `<span style="color:${color}">●</span> <b>${escapeHtml(device.label)}</b><br>` +
              `<span style="font-size:16px"><b>${averaged ? 'Ø ' : ''}%{y:${format}}</b></span> ${unit}` +
              `%{customdata}<br>` +
              `<span style="color:${MUTED_TEXT}">%{x|${hoverTime}}</span><extra></extra>`,
          };
        }),
    [averaged, decimals, devices, format, hoverTime, metric, referenceTime, t, tolerance, unit],
  );

  // Mean over the readings of all devices.
  const overallMean = useMemo(() => mean(baseTraces.flatMap((trace) => trace.y)), [baseTraces]);

  // Every plotted trace: the devices' lines, then their means (dashed, no
  // hover, hidden until the device is hovered), then the overall mean.
  // Highlight and hover map plot traces to devices by this list.
  const plotTraces = useMemo(() => {
    const first = Math.min(...devices.map((device) => device.timestamps[0] ?? Infinity));
    const last = Math.max(...devices.map((device) => device.timestamps[device.timestamps.length - 1] ?? -Infinity));
    const span = Number.isFinite(first) && Number.isFinite(last);
    const meanLine = (deviceId: number | null, name: string, value: number, color: string, kind: 'mean' | 'overall') => ({
      deviceId,
      kind,
      type: 'scatter' as const,
      mode: 'lines' as const,
      name,
      x: [new Date(first * 1000), new Date(last * 1000)],
      y: [value, value],
      line: { color, width: 1.5, dash: 'dash' as const },
      opacity: kind === 'overall' ? 1 : 0,
      hoverinfo: 'skip' as const,
    });
    const means = span
      ? baseTraces
          .filter((trace) => trace.mean != null)
          .map((trace) => meanLine(trace.deviceId, `Ø ${trace.name}`, trace.mean as number, trace.line.color, 'mean'))
      : [];
    const overall = span && overallMean != null ? [meanLine(null, 'Ø', overallMean, OVERALL_MEAN_COLOR, 'overall')] : [];
    return [
      ...baseTraces.map(({ label: _label, mean: _mean, referenceIndex: _reference, ...trace }) => ({
        ...trace,
        kind: 'device' as const,
      })),
      ...means,
      ...overall,
    ];
  }, [baseTraces, devices, overallMean]);

  // The hover highlight is applied straight to the plot (Plotly.restyle) and
  // never goes through the data props: re-feeding data on every hover made
  // Plotly redraw, flicker and re-fit the axes.
  const graphRef = useRef<HTMLElement | null>(null);
  const highlightRef = useRef<number | null>(hoveredDeviceId);

  const applyHighlight = useCallback(() => {
    const gd = graphRef.current;
    if (!gd) {
      return;
    }
    const active = highlightRef.current;
    void Plotly.restyle(
      gd as never,
      {
        'line.width': plotTraces.map((trace) => {
          if (trace.kind !== 'device') {
            return 1.5;
          }
          return trace.deviceId === active ? 4 : 2;
        }),
        // A device's mean shows only while the device is hovered.
        opacity: plotTraces.map((trace) => {
          if (trace.kind === 'overall') {
            return 1;
          }
          if (trace.kind === 'mean') {
            return trace.deviceId === active ? 1 : 0;
          }
          return active == null || trace.deviceId === active ? 1 : 0.3;
        }),
      } as never,
    );
  }, [plotTraces]);

  useEffect(() => {
    highlightRef.current = hoveredDeviceId;
    applyHighlight();
  }, [applyHighlight, hoveredDeviceId]);

  // Plot only re-renders when the revision changes, i.e. for new data or a
  // new reference - not when the parent re-renders for the hovered device.
  const revision = revisionOf(plotTraces);

  if (baseTraces.length === 0) {
    return <div style={{ color: MUTED_TEXT, fontSize: 13 }}>{emptyLabel}</div>;
  }

  return (
    <>
    <div
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 16px', marginBottom: 6 }}
      onMouseLeave={() => onHoverDevice?.(null)}
    >
      {baseTraces.map((trace) => (
        <span
          key={trace.deviceId}
          onMouseEnter={() => onHoverDevice?.(trace.deviceId)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            cursor: 'default',
            color: '#3A3535',
            fontWeight: hoveredDeviceId === trace.deviceId ? 700 : 400,
            opacity: hoveredDeviceId == null || hoveredDeviceId === trace.deviceId ? 1 : 0.4,
          }}
        >
          <span
            style={{ width: 18, height: 3, borderRadius: 2, background: trace.line.color }}
          />
          {trace.label}
          {trace.mean != null && hoveredDeviceId === trace.deviceId && (
            <span style={{ color: MUTED_TEXT, fontWeight: 400 }}>
              Ø {trace.mean.toFixed(decimals)} {unit}
            </span>
          )}
        </span>
      ))}
      {overallMean != null && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: MUTED_TEXT }}>
          <span style={{ width: 18, borderTop: `2px dashed ${OVERALL_MEAN_COLOR}` }} />
          {t('climate_mean_all')} Ø {overallMean.toFixed(decimals)} {unit}
        </span>
      )}
      <span style={{ marginLeft: 'auto', fontSize: 11.5, color: MUTED_TEXT }}>
        {referenceTime != null ? (
          <>
            {t('climate_reference_set', {
              time: formatDate(referenceTime, dailyBuckets ? 'date' : 'dateTime'),
            })}{' '}
            <button
              type="button"
              onClick={() => setReference(null)}
              style={{
                border: 'none',
                background: 'none',
                padding: 0,
                color: 'var(--progeo-orange)',
                fontSize: 11.5,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {t('climate_reference_clear')}
            </button>
          </>
        ) : (
          t('climate_reference_hint')
        )}
      </span>
    </div>
    <Plot
      key={`${axisTitle}|${height}`}
      data={plotTraces.map(({ deviceId: _id, kind: _kind, ...trace }) => trace)}
      revision={revision}
      onInitialized={(_figure, graphDiv) => {
        graphRef.current = graphDiv;
        applyHighlight();
      }}
      // Must not restyle here: react-plotly fires onUpdate on every
      // plotly_restyle, so applying the highlight would loop forever.
      onUpdate={(_figure, graphDiv) => {
        graphRef.current = graphDiv;
      }}
      // A purged div has no _fullLayout - Plotly.restyle on it throws. Happens
      // when a range has no values of the metric (e.g. no battery reading in
      // the last 24 h): the empty label replaces the plot, but the highlight
      // effect still runs for the new (empty) traces.
      onPurge={() => {
        graphRef.current = null;
      }}
      onHover={(event) => {
        const curve = event.points?.[0]?.curveNumber;
        if (curve != null && plotTraces[curve]) {
          onHoverDevice?.(plotTraces[curve].deviceId);
        }
      }}
      onUnhover={() => onHoverDevice?.(null)}
      // A click on a point makes its time the reference; a click on the
      // reference point itself clears it again.
      onClick={(event) => {
        const point = event.points?.[0];
        const trace = point?.curveNumber != null ? baseTraces[point.curveNumber] : undefined;
        const device = trace ? devices.find((entry) => entry.id === trace.deviceId) : undefined;
        const ts = device && point?.pointIndex != null ? device.timestamps[point.pointIndex] : undefined;
        if (trace == null || ts == null) {
          return;
        }
        setReference(point?.pointIndex === trace.referenceIndex ? null : ts * 1000);
      }}
      useResizeHandler
      style={{ width: '100%', height: `${height}px` }}
      config={{ responsive: true, displaylogo: false }}
      layout={{
        autosize: true,
        // Keep zoom/pan when only the highlight changes.
        uirevision: 'keep',
        // Minimal fixed margins - automargin grows them just enough for the
        // tick labels, the axis title and the legend.
        margin: { l: 8, r: 12, t: 8, b: 8 },
        font: { color: plotTheme.brandBlue, size: 12 },
        plot_bgcolor: plotTheme.white,
        paper_bgcolor: 'rgba(0,0,0,0)',
        showlegend: false,
        hovermode: 'closest',
        hoverlabel: {
          bgcolor: plotTheme.white,
          font: { size: 12, color: '#3A3535' },
          align: 'left',
        },
        // The reference time: a dotted vertical line across the plot.
        shapes:
          referenceTime != null
            ? [
                {
                  type: 'line',
                  xref: 'x',
                  yref: 'paper',
                  x0: new Date(referenceTime),
                  x1: new Date(referenceTime),
                  y0: 0,
                  y1: 1,
                  line: { color: 'rgba(235, 99, 59, .7)', width: 1.5, dash: 'dot' },
                },
              ]
            : [],
        xaxis: {
          type: 'date',
          automargin: true,
          showgrid: true,
          gridcolor: plotTheme.warmGray1,
          linecolor: plotTheme.warmGray2,
          ticks: 'outside',
          tickcolor: plotTheme.warmGray2,
          ticklen: 4,
          // Month/year ticks for the long ranges (up to 3 years).
          tickformatstops: [
            { dtickrange: [null, DAY_MS], value: '%H:%M<br>%d.%m.' },
            { dtickrange: [DAY_MS, 14 * DAY_MS], value: '%d.%m.' },
            { dtickrange: ['M1', 'M6'], value: '%m.%Y' },
            { dtickrange: ['M12', null], value: '%Y' },
          ],
          // Vertical guide through the hovered point.
          showspikes: true,
          spikemode: 'across',
          spikesnap: 'data',
          spikedash: 'dot',
          spikecolor: plotTheme.warmGray4,
          spikethickness: 1,
        },
        yaxis: {
          title: { text: axisTitle, standoff: 12 },
          automargin: true,
          tickformat: format,
          showgrid: true,
          gridcolor: plotTheme.warmGray1,
          zeroline: false,
        },
      }}
    />
    </>
  );
};

export default ClimateChart;
