import { useMemo } from 'react';
import Plot from 'react-plotly.js';
import { plotSeriesColors, plotTheme } from '../../styles/plotTheme';

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
        .filter((device) => device[metric].some((value) => value != null))
        .map((device, index) => ({
          type: 'scatter' as const,
          mode: 'lines+markers' as const,
          name: device.label,
          x: device.timestamps.map((ts) => new Date(ts * 1000)),
          y: device[metric],
          connectgaps: true,
          line: { color: plotSeriesColors[index % plotSeriesColors.length], width: 2 },
          marker: { size: 4 },
          hovertemplate: `%{y:.1f} ${unit}<br>%{x|%d.%m.%Y %H:%M}<extra>${device.label}</extra>`,
        })),
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
