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

type MeasurementRow = {
  id: number;
  device: number;
  device_mac?: string | null;
  device_hash?: string | null;
  data_interval: number;
  last_fetched: string | null;
  samples: number[];
  max_sample: number;
  avg_sample: number;
  non_zero_sample: number;
};

const WINDOW_HOURS = 48;

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
  const { enqueueSnackbar } = useSnackbar();
  const ctx = useContext(WebsocketContext) || {};
  const wsMessage = (ctx as any).wsMessage;

  const loadMeasurements = () => {
    void axiosConfig.perform_get(
      auth,
      `/v1/status/measurements/?since_hours=${WINDOW_HOURS}`,
      (response) => {
        const rows = (response?.data?.measurements || []) as MeasurementRow[];
        setMeasurements(rows);
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

  return (
    <>
      <Row>
        <Col>
          <div>
            <h2>Measurements Overview</h2>
            <DataTable
              columns={columns}
              data={measurements}
              pagination
              highlightOnHover
              pointerOnHover
            />
          </div>
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
