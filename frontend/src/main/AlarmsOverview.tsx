import { useCallback, useEffect, useMemo, useState } from 'react';
import DataTable from 'react-data-table-component';
import type { TableColumn } from 'react-data-table-component';
import { Badge, Button, Card, Container, Spinner } from 'react-bootstrap';
import { ArrowClockwise, ThermometerHalf } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { showErrorBar } from '../components/ui/Snackbar.jsx';
import SensorHeatmap2D from '../components/device/SensorHeatmap2D.tsx';
import { type SensorHeatmapResponse } from '../components/device/SensorHeatmap3D.tsx';

type AlarmDevice = {
  id?: number | null;
  mac?: string | null;
  raw_hash?: string | null;
};

type AlarmLocation = {
  id?: number | null;
  project_id?: number | null;
  name?: string | null;
};

type AlarmRow = {
  id: number;
  measurement?: number | null;
  device?: AlarmDevice | null;
  location?: AlarmLocation | null;
  triggered_at?: string | null;
  threshold?: number | null;
  sensor_id?: number | null;
  max_value?: number | null;
  still_active_at?: string | null;
  normalized_at?: string | null;
  status?: number;
  is_active?: boolean;
  duration_seconds?: number | null;
};

const HEATMAP_LIMIT = 300;
const TICK_MS = 1000;

/** Format a duration in seconds as "1d 2h 3m 4s" (skips empty units). */
const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '-';
  }
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0 || secs > 0) parts.push(`${secs}s`);
  return parts.join(' ');
};

const parseTimestamp = (raw?: string | null): number | null => {
  if (!raw) {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
};

const STATUS_LABELS: Record<number, { label: string; variant: string }> = {
  0: { label: 'Neu', variant: 'warning' },
  1: { label: 'Quittiert', variant: 'secondary' },
  2: { label: 'Stoerung', variant: 'danger' },
};

const AlarmsOverview = () => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [rows, setRows] = useState<AlarmRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedAlarm, setSelectedAlarm] = useState<AlarmRow | null>(null);
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [heatmapResponse, setHeatmapResponse] =
    useState<SensorHeatmapResponse | null>(null);
  // Ticks every second so active alarms show a live "how long active" counter.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(intervalId);
  }, []);

  const fetchAlarms = useCallback(() => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      '/v1/alarm/',
      (response) => {
        setRows((response?.data || []) as AlarmRow[]);
        setLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not load alarms: ${reason}`);
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar]);

  useEffect(() => {
    fetchAlarms();
  }, [fetchAlarms]);

  const fetchHeatmap = useCallback(
    (alarm: AlarmRow) => {
      const locationId = alarm.location?.id;
      if (locationId == null) {
        showErrorBar(
          enqueueSnackbar,
          'Alarm has no location to render a heatmap for.',
        );
        return;
      }

      setSelectedAlarm(alarm);
      setHeatmapLoading(true);
      setHeatmapResponse(null);
      void axiosConfig.perform_get(
        auth,
        `/v1/location/${locationId}/heatmap/?limit=${HEATMAP_LIMIT}`,
        (result) => {
          setHeatmapResponse(
            (result?.data || null) as SensorHeatmapResponse | null,
          );
          setHeatmapLoading(false);
        },
        (error) => {
          const reason = error?.response?.data?.reason || error.message;
          showErrorBar(
            enqueueSnackbar,
            `Could not load alarm heatmap: ${reason}`,
          );
          setHeatmapResponse(null);
          setHeatmapLoading(false);
        },
      );
    },
    [auth, enqueueSnackbar],
  );

  const alarmActiveDuration = useCallback(
    (alarm: AlarmRow): number => {
      const triggeredMs = parseTimestamp(alarm.triggered_at);
      if (triggeredMs == null) {
        return 0;
      }
      const normalizedMs = parseTimestamp(alarm.normalized_at);
      const endMs =
        normalizedMs != null ? normalizedMs : alarm.is_active ? now : triggeredMs;
      return Math.max(0, (endMs - triggeredMs) / 1000);
    },
    [now],
  );

  const columns: TableColumn<AlarmRow>[] = [
    {
      name: 'ID',
      selector: (row) => row.id,
      sortable: true,
      width: '90px',
    },
    {
      name: 'Location',
      cell: (row) => {
        const loc = row.location;
        return loc ? `${loc.name || 'Unnamed'} (${loc.project_id ?? loc.id})` : '-';
      },
      sortable: true,
      grow: 1.4,
      wrap: true,
    },
    {
      name: 'Device',
      cell: (row) => row.device?.mac || row.device?.raw_hash || '-',
      sortable: true,
      grow: 1.2,
      wrap: true,
    },
    {
      name: 'Sensor',
      selector: (row) => row.sensor_id ?? '-',
      width: '90px',
    },
    {
      name: 'Threshold',
      selector: (row) => row.threshold ?? '-',
      width: '110px',
    },
    {
      name: 'Max Value',
      selector: (row) => row.max_value ?? '-',
      width: '110px',
    },
    {
      name: 'Triggered At',
      selector: (row) => row.triggered_at || '-',
      sortable: true,
      width: '180px',
      wrap: true,
    },
    {
      name: 'Active For',
      cell: (row) => formatDuration(alarmActiveDuration(row)),
      sortable: true,
      width: '140px',
    },
    {
      name: 'Status',
      cell: (row) => {
        const status = STATUS_LABELS[row.status ?? 0] || STATUS_LABELS[0];
        return (
          <div className="d-flex align-items-center gap-2">
            <Badge bg={row.is_active ? 'danger' : 'success'}>
              {row.is_active ? 'ACTIVE' : 'NORMALIZED'}
            </Badge>
            <Badge bg={status.variant}>{status.label}</Badge>
          </div>
        );
      },
      width: '210px',
    },
  ];

  const conditionalRowStyles = [
    {
      when: (row: AlarmRow) => row.id === selectedAlarm?.id,
      style: {
        backgroundColor: 'rgba(220, 53, 69, 0.10)',
        borderLeft: '3px solid #dc3545',
      },
    },
  ];

  const heatmapTitle = useMemo(() => {
    if (!selectedAlarm) {
      return 'Alarm heatmap';
    }
    const loc = selectedAlarm.location;
    const where = loc ? `${loc.name || 'Unnamed location'} (${loc.project_id ?? loc.id})` : 'unknown location';
    return `Alarm #${selectedAlarm.id} - ${where}`;
  }, [selectedAlarm]);

  return (
    <Container fluid className="py-4">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <div>
          <h2 className="mb-0">Alarms</h2>
          <small className="text-muted">
            {rows.length} alarm(s) for your account
          </small>
        </div>
        <Button
          variant="outline-primary"
          onClick={fetchAlarms}
          disabled={loading}
        >
          <ArrowClockwise className="me-2" />
          Refresh
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        pagination
        progressPending={loading}
        highlightOnHover
        pointerOnHover
        conditionalRowStyles={conditionalRowStyles}
        onRowClicked={(row) => fetchHeatmap(row)}
        dense
      />

      <Card className="border-0 shadow-sm mt-3">
        <Card.Body>
          <div className="d-flex flex-wrap justify-content-between align-items-center mb-2 gap-2">
            <h5 className="mb-0">
              <ThermometerHalf className="me-2 text-danger" />
              {heatmapTitle}
            </h5>
            <small className="text-muted">
              Click an alarm row to load its location heatmap
            </small>
          </div>

          {heatmapLoading ? (
            <div className="d-flex align-items-center gap-2 text-muted py-5 justify-content-center">
              <Spinner size="sm" animation="border" />
              Loading alarm heatmap...
            </div>
          ) : !selectedAlarm ? (
            <div className="text-muted py-5 text-center">
              Select an alarm to display its location heatmap.
            </div>
          ) : (
            <SensorHeatmap2D
              response={heatmapResponse}
              title={heatmapTitle}
            />
          )}
        </Card.Body>
      </Card>
    </Container>
  );
};

export default AlarmsOverview;
