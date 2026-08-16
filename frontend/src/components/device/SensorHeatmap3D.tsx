import React from 'react';
import { Card } from 'react-bootstrap';
import Plot from 'react-plotly.js';
import { plotTheme } from '../../styles/plotTheme';

export type SensorHeatmapLocation = {
  id?: number | null;
  project_id?: number | null;
  lageplan_url?: string | null;
  offset_x?: number | null;
  offset_y?: number | null;
  scale_x?: number | null;
  scale_y?: number | null;
  flip_x?: boolean;
  flip_y?: boolean;
};

export type SensorHeatmapResponse = {
  timestamps: number[];
  limit?: number;
  data: Record<string, Array<number | null>>;
  sensor_points?: Array<{
    pos: number;
    x: number;
    y: number;
  }>;
  location?: SensorHeatmapLocation | null;
};

type SensorHeatmap3DProps = {
  response: SensorHeatmapResponse | null | undefined;
  title?: string;
  height?: number;
};

const formatTimestamp = (timestamp: number) => {
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toISOString();
};

const SensorHeatmap3D = ({
  response,
  title = 'Sensor measurements',
  height = 620,
}: SensorHeatmap3DProps) => {
  const chart = React.useMemo(() => {
    if (!response || !Array.isArray(response.timestamps)) {
      return null;
    }

    const sensors = Object.keys(response.data || {});
    const timestamps = response.timestamps;

    if (!sensors.length || !timestamps.length) {
      return null;
    }

    const y = timestamps.map(formatTimestamp);
    const z = timestamps.map((_, timestampIndex) =>
      sensors.map((sensor) => {
        const value = response.data[sensor]?.[timestampIndex];
        return value == null || !Number.isFinite(Number(value))
          ? null
          : Number(value);
      }),
    );

    return { sensors, timestamps, y, z };
  }, [response]);

  return (
    <Card className="border-0 shadow-sm">
      <Card.Body>
        <div className="d-flex flex-wrap justify-content-between align-items-center mb-2">
          <h5 className="mb-0">{title}</h5>
          {chart && (
            <small className="text-muted">
              {chart.sensors.length} sensors, {chart.timestamps.length}{' '}
              timestamps
            </small>
          )}
        </div>

        {!chart ? (
          <div className="text-muted py-5 text-center">
            No sensor measurements available.
          </div>
        ) : (
          <Plot
            data={[
              {
                type: 'surface',
                x: chart.sensors,
                y: chart.y,
                z: chart.z,
                colorscale: [
                  [0, plotTheme.brandBlue],
                  [0.35, plotTheme.contrastCyan],
                  [0.65, plotTheme.contrastYellow],
                  [1, plotTheme.brandOrange],
                ],
                colorbar: {
                  title: { text: 'Value' },
                  thickness: 14,
                },
                hovertemplate:
                  'Sensor: %{x}<br>Timestamp: %{y}<br>Value: %{z:.3f}<extra></extra>',
              },
            ]}
            layout={{
              height,
              autosize: true,
              margin: { l: 0, r: 0, t: 12, b: 0 },
              paper_bgcolor: 'transparent',
              plot_bgcolor: 'transparent',
              scene: {
                aspectmode: 'auto',
                camera: {
                  projection: { type: 'orthographic' },
                  eye: { x: 1.55, y: 1.55, z: 1.25 },
                },
                xaxis: { title: { text: 'Sensor' }, tickangle: -35 },
                yaxis: { title: { text: 'Timestamp' }, type: 'date' },
                zaxis: { title: { text: 'Value' } },
              },
              font: { family: 'inherit', color: plotTheme.brandBlue },
            }}
            config={{
              responsive: true,
              displaylogo: false,
              modeBarButtonsToRemove: ['lasso2d', 'select2d'],
            }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        )}
      </Card.Body>
    </Card>
  );
};

export default SensorHeatmap3D;
