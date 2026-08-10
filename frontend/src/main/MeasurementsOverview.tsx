import { useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig.tsx';
import { showErrorBar } from '../components/ui/Snackbar.jsx';
import { useSnackbar } from 'notistack';
import { WebsocketContext } from '../components/ws/websocketContext.jsx';
import { Card, Col, Row } from 'react-bootstrap';
import DataTable from 'react-data-table-component';
import type { TableColumn } from 'react-data-table-component';
import DeviceChart, {
  DeviceSeries,
} from '../components/device/DeviceChart.tsx';
import MeasurementSamplesCompareChart from '../components/device/MeasurementSamplesCompareChart.tsx';
import MeasurementHeatmap, {
  HeatmapPoint,
} from '../components/device/MeasurementHeatmap.tsx';

type MeasurementRow = {
  id: number;
  device: number;
  device_mac?: string | null;
  device_hash?: string | null;
  data_interval: number;
  last_fetched: string | null;
  samples: number[];
  pair_abs_values?: number[];
  pair_count?: number;
  is_watching?: boolean;
  project_id?: number | null;
  max_sample: number;
  avg_sample: number;
  non_zero_sample: number;
};

type DeviceOverviewRow = {
  device: number;
  device_mac?: string | null;
  device_hash?: string | null;
  measurement_count: number;
  watching_count: number;
  latest_measurement_id?: number | null;
  latest_last_fetched?: string | null;
};

const WINDOW_HOURS = 8;

const formatDate = (value: string | null | undefined) => {
  if (!value) {
    return '-';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
};

const formatDeviceLabel = (row: MeasurementRow) => {
  if (row.device_mac && row.device_mac.trim()) {
    return `Device ${row.device} (${row.device_mac})`;
  }
  if (row.device_hash && row.device_hash.trim()) {
    return `Device ${row.device} (${row.device_hash.slice(0, 12)}...)`;
  }
  return `Device ${row.device}`;
};

const MeasurementsOverview = () => {
  const auth = useAuth();
  const [measurements, setMeasurements] = useState<MeasurementRow[]>([]);
  const [overviewByDevice, setOverviewByDevice] = useState<DeviceOverviewRow[]>(
    [],
  );
  const [selectedRows, setSelectedRows] = useState<MeasurementRow[]>([]);
  const [heatmapInput, setHeatmapInput] = useState<string>(
    JSON.stringify(
      [
        { x: 160, y: 130, intensity: 0.95, radius: 80 },
        { x: 230, y: 160, intensity: 0.85, radius: 90 },
        { x: 340, y: 210, intensity: 0.78, radius: 70 },
        { x: 420, y: 120, intensity: 0.65, radius: 60 },
        { x: 520, y: 190, intensity: 1.0, radius: 100 },
      ],
      null,
      2,
    ),
  );
  const { enqueueSnackbar } = useSnackbar();
  const ctx = useContext(WebsocketContext) || {};
  const wsMessage = (ctx as any).wsMessage;

  const loadMeasurements = () => {
    void axiosConfig.perform_get(
      auth,
      `/v1/status/measurements/?since_hours=${WINDOW_HOURS}`,
      (response) => {
        const rows = (response?.data?.measurements || []) as MeasurementRow[];
        const overview = (response?.data?.overview_by_device ||
          []) as DeviceOverviewRow[];
        setMeasurements(rows);
        setOverviewByDevice(overview);
        setSelectedRows((previous) => {
          if (!previous.length) {
            return previous;
          }
          const selectedIds = new Set(previous.map((row) => row.id));
          return rows.filter((row) => selectedIds.has(row.id));
        });
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(
          enqueueSnackbar,
          `Could not load ${WINDOW_HOURS}h measurements: ${reason}`,
        );
      },
    );
  };

  const setWatching = (row: MeasurementRow, isWatching: boolean) => {
    void axiosConfig.perform_post(
      auth,
      '/v1/status/measurements/watch/',
      {
        measurement_id: row.id,
        is_watching: isWatching,
      },
      () => {
        setMeasurements((previous) =>
          previous.map((entry) =>
            entry.id === row.id ? { ...entry, is_watching: isWatching } : entry,
          ),
        );
        setSelectedRows((previous) =>
          previous.map((entry) =>
            entry.id === row.id ? { ...entry, is_watching: isWatching } : entry,
          ),
        );
        loadMeasurements();
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not update watch flag: ${reason}`);
      },
    );
  };

  useEffect(() => {
    loadMeasurements();
  }, []);

  useEffect(() => {
    if (!wsMessage) {
      return;
    }
    loadMeasurements();
  }, [wsMessage]);
  const columns: TableColumn<MeasurementRow>[] = [
    {
      name: 'ID',
      selector: (row) => row.id,
      sortable: true,
      width: '90px',
    },
    {
      name: 'Device',
      selector: (row) => row.device,
      sortable: true,
      width: '110px',
    },
    {
      name: 'Interval (s)',
      selector: (row) => row.data_interval,
      sortable: true,
      width: '130px',
    },
    {
      name: 'Last Fetched',
      selector: (row) => formatDate(row.last_fetched),
      sortable: true,
      grow: 1.5,
    },
    {
      name: 'Samples',
      selector: (row) => row.samples.join(', '),
      grow: 2,
      wrap: true,
    },
    {
      name: 'Pairs',
      selector: (row) =>
        row.pair_count || Math.floor((row.samples || []).length / 2),
      sortable: true,
      width: '90px',
    },
    {
      name: 'Max',
      selector: (row) => row.max_sample,
      sortable: true,
      width: '110px',
    },
    {
      name: 'Avg',
      selector: (row) => Number(row.avg_sample.toFixed(2)),
      sortable: true,
      width: '110px',
    },
    {
      name: 'Non-zero',
      selector: (row) => row.non_zero_sample,
      sortable: true,
      width: '120px',
    },
    {
      name: 'Watch',
      cell: (row) => (
        <button
          type="button"
          className={`btn btn-sm ${row.is_watching ? 'btn-warning' : 'btn-outline-secondary'}`}
          onClick={() => setWatching(row, !row.is_watching)}
        >
          {row.is_watching ? 'Watching' : 'Watch'}
        </button>
      ),
      width: '120px',
    },
  ];

  const groupedSeries = useMemo<DeviceSeries[]>(() => {
    const minTime = Date.now() - WINDOW_HOURS * 60 * 60 * 1000;
    const groups = new Map<number, DeviceSeries>();

    measurements.forEach((row) => {
      if (!row.last_fetched) {
        return;
      }
      const timeMs = new Date(row.last_fetched).getTime();
      if (!Number.isFinite(timeMs) || timeMs < minTime) {
        return;
      }

      if (!groups.has(row.device)) {
        groups.set(row.device, {
          deviceId: row.device,
          label: formatDeviceLabel(row),
          points: [],
        });
      }

      const group = groups.get(row.device);
      if (!group) {
        return;
      }
      group.points.push({
        id: row.id,
        timeMs,
        timeLabel: formatDate(row.last_fetched),
        avg: Number(row.avg_sample || 0),
        max: Number(row.max_sample || 0),
      });
    });

    return Array.from(groups.values())
      .map((series) => ({
        ...series,
        points: [...series.points].sort((a, b) => a.timeMs - b.timeMs),
      }))
      .sort((a, b) => a.deviceId - b.deviceId);
  }, [measurements]);

  const heatmapPoints = useMemo<HeatmapPoint[]>(() => {
    try {
      const parsed = JSON.parse(heatmapInput);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .map((item) => ({
          x: Number(item?.x),
          y: Number(item?.y),
          intensity:
            item?.intensity === undefined ? undefined : Number(item.intensity),
          radius: item?.radius === undefined ? undefined : Number(item.radius),
        }))
        .filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y));
    } catch (_error) {
      return [];
    }
  }, [heatmapInput]);

  const heatmapInputValid = useMemo(() => {
    try {
      const parsed = JSON.parse(heatmapInput);
      return Array.isArray(parsed);
    } catch (_error) {
      return false;
    }
  }, [heatmapInput]);

  return (
    <>
      <Row>
        <Col>
          <h2>Device Overview</h2>
          <Row className="g-3 mb-3">
            {overviewByDevice.map((entry) => (
              <Col key={entry.device} xl={3} lg={4} md={6} sm={12}>
                <Card className="border-0 shadow-sm h-100">
                  <Card.Body>
                    <div className="fw-semibold mb-1">
                      Device {entry.device}
                    </div>
                    <div className="text-muted small mb-2">
                      {entry.device_mac || entry.device_hash || '-'}
                    </div>
                    <div className="small">
                      Measurements: {entry.measurement_count}
                    </div>
                    <div className="small">
                      Watching: {entry.watching_count}
                    </div>
                    <div className="small text-muted mt-1">
                      Latest: {formatDate(entry.latest_last_fetched)}
                    </div>
                  </Card.Body>
                </Card>
              </Col>
            ))}
          </Row>

          <div>
            <h2>Measurements Overview</h2>
            <DataTable
              columns={columns}
              data={measurements}
              pagination
              highlightOnHover
              pointerOnHover
              selectableRows
              selectableRowsHighlight
              onSelectedRowsChange={({ selectedRows: next }) => {
                setSelectedRows(next as MeasurementRow[]);
              }}
            />
          </div>
        </Col>
      </Row>
      <Row className="mt-3">
        <Col>
          <h2>Compare Measurements</h2>
          <p className="text-muted mb-3">
            Select at least two rows above to compare sample-pair deltas. Each
            measurement line uses pair index i with value |sample[2i] -
            sample[2i+1]|.
          </p>

          {selectedRows.length < 2 ? (
            <Card className="border-0 shadow-sm">
              <Card.Body className="text-muted">
                Select two or more measurements in the table to render the
                comparison chart.
              </Card.Body>
            </Card>
          ) : (
            <MeasurementSamplesCompareChart rows={selectedRows} />
          )}
        </Col>
      </Row>
      <Row className="mt-3">
        <Col>
          <h2>Heatmap Playground</h2>
          <p className="text-muted mb-3">
            Provide points as JSON with x, y, and intensity/radius. Overlapping
            circles merge smoothly using additive blending.
          </p>

          <Card className="border-0 shadow-sm mb-3">
            <Card.Body>
              <label htmlFor="heatmap-points-input" className="form-label">
                Points JSON
              </label>
              <textarea
                id="heatmap-points-input"
                className={`form-control ${heatmapInputValid ? '' : 'is-invalid'}`}
                rows={8}
                value={heatmapInput}
                onChange={(event) => setHeatmapInput(event.target.value)}
              />
              {!heatmapInputValid && (
                <div className="invalid-feedback d-block">
                  Invalid JSON. Use an array of objects, e.g.{' '}
                  <code>{`[{"x":120,"y":80,"intensity":0.9,"radius":70}]`}</code>
                  .
                </div>
              )}
            </Card.Body>
          </Card>

          <MeasurementHeatmap
            title="Merged Circle Heatmap"
            points={heatmapPoints}
            width={760}
            height={340}
          />
        </Col>
      </Row>
      <Row>
        <Col>
          <h2>Measurements: Last {WINDOW_HOURS}h Per Device</h2>
          <p className="text-muted mb-3">
            One chart per device. Blue shows average sample value, orange shows
            max sample value.
          </p>

          {!groupedSeries.length && (
            <Card className="border-0 shadow-sm">
              <Card.Body className="text-muted">
                No measurement data available in the last {WINDOW_HOURS} hours.
              </Card.Body>
            </Card>
          )}

          {groupedSeries.map((series) => (
            <DeviceChart key={series.deviceId} series={series} />
          ))}
        </Col>
      </Row>
    </>
  );
};
export default MeasurementsOverview;
