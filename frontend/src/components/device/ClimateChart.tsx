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
            name: device.label,
            x: device.timestamps.map((ts) => new Date(ts * 1000)),
            y: device[metric],
            connectgaps: true,
            line: {
              color,
              width: 2,
              dash: DASHES[Math.floor(index / colors.length) % DASHES.length],
            },
            marker: { size: 6, color },
            hovertemplate: `%{y:.1f} ${unit}<br>%{x|%d.%m.%Y %H:%M}<extra>${device.label}</extra>`,
          };
        }),
    [devices, metric, unit],
  );

  if (traces.length === 0) {
    return <div style={{ color: '#8B8383', fontSize: 13 }}>{emptyLabel}</div>;
  }

  return (
    <Plot
      data={traces}
      useResizeHandler
      style={{ width: '100%', height: `${height}px` }}
      config={{ responsive: true, displaylogo: false }}
      layout={{
        autosize: true,
        margin: { l: 56, r: 16, t: 16, b: 40 },
        font: { color: plotTheme.brandBlue },
        plot_bgcolor: plotTheme.warmGray1,
        paper_bgcolor: 'rgba(0,0,0,0)',
        showlegend: true,
        legend: { orientation: 'h', y: -0.18 },
        hovermode: 'closest',
        xaxis: {
          type: 'date',
          showgrid: true,
          gridcolor: plotTheme.warmGray2,
        },
        yaxis: {
          title: { text: axisTitle },
          showgrid: true,
          gridcolor: plotTheme.warmGray2,
          zeroline: false,
        },
      }}
    />
  );
};

export default ClimateChart;
