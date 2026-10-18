import { useMemo } from 'react';
import Plot from 'react-plotly.js';
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
};

export type ClimateResponse = {
  days: number;
  devices: ClimateDeviceSeries[];
};

export type ClimateMetric = 'humidity' | 'temperature';

// Temperature reads warm, humidity cool. The shades vary in hue as well as
// lightness so neighbouring devices stay apart. A device keeps its index in
// both charts, so it is the n-th red and the n-th blue. Lines are always
// solid; beyond the fixed shades more are generated (see deviceColor).
const METRIC_COLORS: Record<ClimateMetric, string[]> = {
  temperature: [
    '#C62828', '#EF6C00', '#AD1457', '#D9605A', '#7B1F12', '#E8913A',
    '#F9A825', '#8E24AA', '#BF360C', '#FF7043', '#6D4C41', '#E91E63',
  ],
  humidity: [
    '#1565C0', '#00838F', '#5E35B1', '#4A9BE0', '#0D2F6B', '#2BA3B5',
    '#2E7D32', '#3949AB', '#0277BD', '#26A69A', '#6A1B9A', '#00ACC1',
  ],
};
// Hue ranges of the generated shades: warm (reds/oranges) and cool (blues/greens).
const GENERATED_HUES: Record<ClimateMetric, [number, number]> = {
  temperature: [-20, 50],
  humidity: [160, 270],
};

const deviceColor = (metric: ClimateMetric, index: number): string => {
  const colors = METRIC_COLORS[metric];
  if (index < colors.length) return colors[index];
  const extra = index - colors.length;
  const [from, to] = GENERATED_HUES[metric];
  // Golden-angle steps spread hue and lightness so consecutive shades differ.
  const hue = (from + ((extra * 137.5) % (to - from)) + 360) % 360;
  const lightness = 32 + ((extra * 17) % 30);
  return `hsl(${hue.toFixed(0)}, 65%, ${lightness}%)`;
};

const MUTED_TEXT = '#8B8383';
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
};

/**
 * Time series of one climate metric (humidity or temperature), one line per
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
}: ClimateChartProps) => {
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
            marker: { size: 6, color },
            hoverlabel: { bordercolor: color },
            hovertemplate:
              `<span style="color:${color}">●</span> <b>${escapeHtml(device.label)}</b><br>` +
              `<span style="font-size:16px"><b>%{y:.2f}</b></span> ${unit}<br>` +
              `<span style="color:${MUTED_TEXT}">%{x|%d.%m.%Y, %H:%M}</span><extra></extra>`,
          };
        }),
    [devices, metric, unit],
  );

  // Highlight: the hovered device gets a thicker line, the others fade.
  const traces = useMemo(
    () =>
      baseTraces.map(({ deviceId, ...trace }) => {
        if (hoveredDeviceId == null) return trace;
        const active = deviceId === hoveredDeviceId;
        return {
          ...trace,
          opacity: active ? 1 : 0.3,
          line: { ...trace.line, width: active ? 4 : 2 },
          marker: { ...trace.marker, size: active ? 8 : 6 },
        };
      }),
    [baseTraces, hoveredDeviceId],
  );

  if (traces.length === 0) {
    return <div style={{ color: MUTED_TEXT, fontSize: 13 }}>{emptyLabel}</div>;
  }

  return (
    <Plot
      data={traces}
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
        showlegend: true,
        legend: {
          orientation: 'h',
          x: 0,
          xanchor: 'left',
          y: 1.02,
          yanchor: 'bottom',
          font: { size: 12 },
        },
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
          tickformatstops: [
            { dtickrange: [null, DAY_MS], value: '%H:%M<br>%d.%m.' },
            { dtickrange: [DAY_MS, null], value: '%d.%m.' },
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
          tickformat: '.2f',
          showgrid: true,
          gridcolor: plotTheme.warmGray1,
          zeroline: false,
        },
      }}
    />
  );
};

export default ClimateChart;
