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
// lightness so neighbouring devices stay apart; beyond six devices the
// shades repeat with a different dash. A device keeps its index in both
// charts, so it is the n-th red and the n-th blue.
const METRIC_COLORS: Record<ClimateMetric, string[]> = {
  temperature: ['#C62828', '#EF6C00', '#AD1457', '#D9605A', '#7B1F12', '#E8913A'],
  humidity: ['#1565C0', '#00838F', '#5E35B1', '#4A9BE0', '#0D2F6B', '#2BA3B5'],
};
const DASHES = ['solid', 'dash', 'dot'] as const;

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
}: ClimateChartProps) => {
  const traces = useMemo(
    () =>
      devices
        // Index before filtering: a device's style follows the device, not
        // which other devices happen to have readings.
        .map((device, index) => ({ device, index }))
        .filter(({ device }) => device[metric].some((value) => value != null))
        .map(({ device, index }) => {
          const colors = METRIC_COLORS[metric];
          const color = colors[index % colors.length];
          return {
            type: 'scatter' as const,
            mode: 'lines+markers' as const,
            name: escapeHtml(device.label),
            x: device.timestamps.map((ts) => new Date(ts * 1000)),
            y: device[metric],
            connectgaps: true,
            line: {
              color,
              width: 2,
              dash: DASHES[Math.floor(index / colors.length) % DASHES.length],
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

  if (traces.length === 0) {
    return <div style={{ color: MUTED_TEXT, fontSize: 13 }}>{emptyLabel}</div>;
  }

  return (
    <Plot
      data={traces}
      useResizeHandler
      style={{ width: '100%', height: `${height}px` }}
      config={{ responsive: true, displaylogo: false }}
      layout={{
        autosize: true,
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
