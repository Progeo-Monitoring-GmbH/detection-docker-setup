import { useCallback, useEffect, useMemo, useRef } from 'react';
import Plot from 'react-plotly.js';
import Plotly from 'plotly.js/dist/plotly';
import { plotTheme } from '../../styles/plotTheme';

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
};

/**
 * Time series of one climate metric (humidity, temperature, battery or battery voltage), one line per
 * device of the location - a LoRaWAN object has several sensors.
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
}: ClimateChartProps) => {
  // Averaged data: smaller markers (many evenly spaced points), the value
  // marked as a mean, and no time of day once a bucket spans a whole day.
  const averaged = bucketSeconds != null && bucketSeconds > 0;
  const hoverTime =
    averaged && bucketSeconds * 1000 >= DAY_MS ? '%d.%m.%Y' : '%d.%m.%Y, %H:%M';
  const baseTraces = useMemo(
    () =>
      devices
        // Index before filtering: a device's style follows the device, not
        // which other devices happen to have readings.
        .map((device, index) => ({ device, index }))
        .filter(({ device }) => device[metric].some((value) => value != null))
        .map(({ device, index }) => {
          const color = deviceColor(metric, index);
          return {
            deviceId: device.id,
            label: device.label,
            type: 'scatter' as const,
            mode: 'lines+markers' as const,
            name: escapeHtml(device.label),
            x: device.timestamps.map((ts) => new Date(ts * 1000)),
            y: device[metric],
            connectgaps: true,
            line: {
              color,
              width: 2,
            },
            marker: { size: averaged ? 3 : 6, color },
            hoverlabel: { bordercolor: color },
            hovertemplate:
              `<span style="color:${color}">●</span> <b>${escapeHtml(device.label)}</b><br>` +
              `<span style="font-size:16px"><b>${averaged ? 'Ø ' : ''}%{y:${VALUE_FORMAT[metric]}}</b></span> ${unit}<br>` +
              `<span style="color:${MUTED_TEXT}">%{x|${hoverTime}}</span><extra></extra>`,
          };
        }),
    [averaged, devices, hoverTime, metric, unit],
  );

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
        'line.width': baseTraces.map((trace) => (trace.deviceId === active ? 4 : 2)),
        opacity: baseTraces.map((trace) => (active == null || trace.deviceId === active ? 1 : 0.3)),
      } as never,
    );
  }, [baseTraces]);

  useEffect(() => {
    highlightRef.current = hoveredDeviceId;
    applyHighlight();
  }, [applyHighlight, hoveredDeviceId]);

  // Plot only re-renders when the revision changes, i.e. for new data - not
  // when the parent re-renders because of the hovered device.
  const revision = revisionOf(baseTraces);

  if (baseTraces.length === 0) {
    return <div style={{ color: MUTED_TEXT, fontSize: 13 }}>{emptyLabel}</div>;
  }

  return (
    <>
    <div
      style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginBottom: 6 }}
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
        </span>
      ))}
    </div>
    <Plot
      key={`${axisTitle}|${height}`}
      data={baseTraces.map(({ deviceId: _id, label: _label, ...trace }) => trace)}
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
        if (curve != null && baseTraces[curve]) {
          onHoverDevice?.(baseTraces[curve].deviceId);
        }
      }}
      onUnhover={() => onHoverDevice?.(null)}
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
          tickformat: VALUE_FORMAT[metric],
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
