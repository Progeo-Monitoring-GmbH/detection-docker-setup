import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DataTable from 'react-data-table-component';
import type { TableColumn } from 'react-data-table-component';
import { Badge, Button, Card, Container, Form, Spinner } from 'react-bootstrap';
import {
  ArrowClockwise,
  Check2Circle,
  ThermometerHalf,
} from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import { FilterComponent } from '../components/ui/FilterComponent.jsx';
import SensorHeatmap2D from '../components/device/SensorHeatmap2D.tsx';
import { type SensorHeatmapResponse } from '../components/device/SensorHeatmap3D.tsx';
import AlarmTimeline, {
  alarmStartTime,
  formatDuration,
  isAlarmActive,
  parseTimestamp,
} from './AlarmTimeline.tsx';

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

type AlarmEvaluatedBy = {
  id?: number | null;
  username?: string | null;
};

type AlarmMaxValueEntry = {
  ts?: string | null;
  value?: number | null;
  sensor_id?: number | null;
};

type AlarmSensorMaxValue = {
  sensor_id?: number | null;
  max_value?: number | null;
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
  evaluated_at?: string | null;
  evaluated_by?: AlarmEvaluatedBy | null;
  status?: number;
  is_active?: boolean;
  duration_seconds?: number | null;
  max_values?: AlarmMaxValueEntry[];
  sensor_max_values?: AlarmSensorMaxValue[];
};

const HEATMAP_LIMIT = 300;
// Live "how long active" counter: 30s granularity is plenty and avoids
// re-rendering the whole timeline every second.
const TICK_MS = 30_000;
// Default alarm window: the backend also defaults to 14 days, but passing it
// explicitly keeps the overview bounded even if the backend default changes.
const DEFAULT_ALARM_DAYS = 14;

/**
 * Convert a ms timestamp to a naive local ISO string (no timezone suffix),
 * matching the format the backend serializer emits, so `from`/`to` round-trip
 * through datetime.fromisoformat on the server.
 */
const toLocalIso = (ms: number): string => {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
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
  const [filterText, setFilterText] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const [onlyLastHour, setOnlyLastHour] = useState(false);
  const [acknowledgingId, setAcknowledgingId] = useState<number | null>(null);
  const heatmapCardRef = useRef<HTMLDivElement | null>(null);
  // Only ticks while at least one alarm is active (or the last-hour filter is
  // on, so the window stays rolling); frozen otherwise, so the timeline does
  // not re-render when all alarms are normalized.
  const [now, setNow] = useState(() => Date.now());

  const hasActiveAlarm = useMemo(
    () => rows.some((row) => isAlarmActive(row)),
    [rows],
  );

  useEffect(() => {
    if (!hasActiveAlarm && !onlyLastHour) {
      return undefined;
    }
    const intervalId = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(intervalId);
  }, [hasActiveAlarm, onlyLastHour]);

  const fetchAlarms = useCallback(() => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/alarm/?days=${DEFAULT_ALARM_DAYS}`,
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

      // Scope the heatmap to the alarm's active window (trigger -> normalized,
      // or -> now while still active), with a little padding for context.
      const startMs = alarmStartTime(alarm);
      const normalizedMs = parseTimestamp(alarm.normalized_at);
      const endMs =
        normalizedMs != null
          ? normalizedMs
          : isAlarmActive(alarm)
            ? now
            : (startMs ?? now);
      const padMs = 5 * 60 * 1000; // 5 minutes each side
      const fromMs = startMs != null ? startMs - padMs : now - padMs;
      const toMs = endMs + padMs;

      const params = new URLSearchParams({
        limit: String(HEATMAP_LIMIT),
        from: toLocalIso(fromMs),
        to: toLocalIso(toMs),
      });

      setSelectedAlarm(alarm);
      setHeatmapLoading(true);
      setHeatmapResponse(null);
      void axiosConfig.perform_get(
        auth,
        `/v1/location/${locationId}/heatmap/?${params.toString()}`,
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

      // Bring the heatmap card into view once the selection is made.
      window.setTimeout(() => {
        heatmapCardRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      }, 50);
    },
    [auth, enqueueSnackbar, now],
  );

  const acknowledgeAlarm = useCallback(
    (alarm: AlarmRow) => {
      setAcknowledgingId(alarm.id);
      void axiosConfig.perform_post(
        auth,
        `/v1/alarm/${alarm.id}/acknowledge/`,
        {},
        (response) => {
          const updated = (response?.data || null) as AlarmRow | null;
          if (updated) {
            setRows((prev) =>
              prev.map((row) => (row.id === updated.id ? updated : row)),
            );
          }
          showSuccessBar(enqueueSnackbar, `Alarm #${alarm.id} acknowledged.`);
          setAcknowledgingId(null);
        },
        (error) => {
          const reason = error?.response?.data?.reason || error.message;
          showErrorBar(
            enqueueSnackbar,
            `Could not acknowledge alarm: ${reason}`,
          );
          setAcknowledgingId(null);
        },
      );
    },
    [auth, enqueueSnackbar],
  );

  const alarmActiveDuration = useCallback(
    (alarm: AlarmRow): number => {
      const triggeredMs = alarmStartTime(alarm);
      if (triggeredMs == null) {
        return 0;
      }
      const normalizedMs = parseTimestamp(alarm.normalized_at);
      const endMs =
        normalizedMs != null
          ? normalizedMs
          : isAlarmActive(alarm)
            ? now
            : triggeredMs;
      return Math.max(0, (endMs - triggeredMs) / 1000);
    },
    [now],
  );

  const filteredRows = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    const lastHourCutoff = onlyLastHour ? now - 60 * 60 * 1000 : null;
    return rows.filter((row) => {
      if (onlyActive && !isAlarmActive(row)) {
        return false;
      }
      if (lastHourCutoff != null) {
        const startMs = alarmStartTime(row);
        if (startMs == null || startMs < lastHourCutoff) {
          return false;
        }
      }
      if (!needle) {
        return true;
      }
      const haystack = [
        String(row.id),
        row.location?.name,
        row.location?.project_id != null ? String(row.location.project_id) : '',
        row.device?.mac,
        row.device?.raw_hash,
        row.sensor_id != null ? String(row.sensor_id) : '',
        (Array.isArray(row.sensor_max_values) ? row.sensor_max_values : [])
          .map((pair) => String(pair.sensor_id ?? ''))
          .join(' '),
        isAlarmActive(row) ? 'active' : 'normalized',
        STATUS_LABELS[row.status ?? 0]?.label,
        row.status === 1 ? 'acknowledged' : '',
        row.evaluated_by?.username,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return haystack.includes(needle);
    });
  }, [rows, filterText, onlyActive, onlyLastHour, now]);

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
        return loc
          ? `${loc.name || 'Unnamed'} (${loc.project_id ?? loc.id})`
          : '-';
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
      name: 'Sensors',
      cell: (row) => {
        const pairs = Array.isArray(row.sensor_max_values)
          ? row.sensor_max_values
          : [];
        if (pairs.length === 0) {
          return row.sensor_id != null ? String(row.sensor_id) : '-';
        }
        return pairs
          .map((pair) => `#${pair.sensor_id ?? '-'}`)
          .join(', ');
      },
      width: '160px',
      wrap: true,
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
      cell: (row) => {
        const ms = alarmStartTime(row);
        return ms != null
          ? new Date(ms).toLocaleString()
          : row.triggered_at || '-';
      },
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
        const active = isAlarmActive(row);
        const acknowledged = row.status === 1;
        return (
          <div className="d-flex flex-column gap-1">
            <div className="d-flex align-items-center gap-2">
              <Badge bg={active ? 'danger' : 'success'}>
                {active ? 'ACTIVE' : 'NORMALIZED'}
              </Badge>
              <Badge bg={status.variant}>{status.label}</Badge>
            </div>
            {acknowledged && (
              <small className="text-muted">
                by {row.evaluated_by?.username || 'unknown'} ·{' '}
                {row.evaluated_at
                  ? (() => {
                      const ms = parseTimestamp(row.evaluated_at);
                      return ms != null
                        ? new Date(ms).toLocaleString()
                        : row.evaluated_at;
                    })()
                  : '-'}
              </small>
            )}
          </div>
        );
      },
      width: '260px',
    },
    {
      name: 'Actions',
      width: '150px',
      cell: (row) => {
        const acknowledged = row.status === 1;
        return (
          <Button
            size="sm"
            variant={acknowledged ? 'outline-success' : 'success'}
            disabled={acknowledged || acknowledgingId === row.id}
            title={
              acknowledged
                ? 'Alarm already acknowledged'
                : 'Acknowledge this alarm'
            }
            onClick={(event) => {
              event.stopPropagation();
              acknowledgeAlarm(row);
            }}
          >
            {acknowledgingId === row.id ? (
              <Spinner size="sm" animation="border" />
            ) : (
              <Check2Circle className="me-1" />
            )}
            {acknowledged ? 'Acknowledged' : 'Acknowledge'}
          </Button>
        );
      },
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
    const where = loc
      ? `${loc.name || 'Unnamed location'} (${loc.project_id ?? loc.id})`
      : 'unknown location';
    const startMs = alarmStartTime(selectedAlarm);
    const normalizedMs = parseTimestamp(selectedAlarm.normalized_at);
    const endMs =
      normalizedMs != null
        ? normalizedMs
        : isAlarmActive(selectedAlarm)
          ? now
          : (startMs ?? now);
    const range =
      startMs != null && endMs != null
        ? `${new Date(startMs).toLocaleString()} → ${new Date(
            endMs,
          ).toLocaleString()}`
        : '';
    return `Alarm #${selectedAlarm.id} - ${where}${range ? ` (${range})` : ''}`;
  }, [selectedAlarm, now]);

  const handleClearFilter = () => setFilterText('');

  return (
    <Container fluid className="py-4">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <div>
          <h2 className="mb-0">Alarms</h2>
          <small className="text-muted">
            {filteredRows.length} of {rows.length} alarm(s) for your account
          </small>
        </div>
        <div className="d-flex flex-wrap align-items-center gap-2">
          <Form.Check
            type="switch"
            id="alarms-only-active"
            label="Only with active alarms"
            checked={onlyActive}
            onChange={(event) => setOnlyActive(event.target.checked)}
            title="Show only alarms that are currently active"
          />
          <Form.Check
            type="switch"
            id="alarms-only-last-hour"
            label="Only show last hour"
            checked={onlyLastHour}
            onChange={(event) => setOnlyLastHour(event.target.checked)}
            title="Show only alarms triggered within the last hour"
          />
          <FilterComponent
            filterText={filterText}
            onFilter={(event) => setFilterText(event.target.value)}
            onClear={handleClearFilter}
          />
          <Button
            variant="outline-primary"
            onClick={fetchAlarms}
            disabled={loading}
          >
            <ArrowClockwise className="me-2" />
            Refresh
          </Button>
        </div>
      </div>

      <Card className="border-0 shadow-sm mb-3 p-2">
        <Card.Body>
          <div className="d-flex flex-wrap justify-content-between align-items-center mb-2 gap-2">
            <h5 className="mb-0">Alarm Timeline</h5>
            <small className="text-muted">
              Grouped by location — hover a bar for details, click to load the
              heatmap
            </small>
          </div>
          <AlarmTimeline
            alarms={filteredRows}
            now={now}
            selectedAlarmId={selectedAlarm?.id}
            onSelectAlarm={(alarm) => fetchHeatmap(alarm)}
          />
        </Card.Body>
      </Card>

      <Card
        ref={heatmapCardRef}
        className="border-0 shadow-sm my-5 p-2"
      >
        <Card.Body>
          <div className="d-flex flex-wrap justify-content-between align-items-center mb-2 gap-2">
            <h5 className="mb-0">
              <ThermometerHalf className="me-2 text-danger" />
              {heatmapTitle}
            </h5>
            <small className="text-muted">
              Click an alarm row or timeline bar to load its location heatmap
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
            <SensorHeatmap2D response={heatmapResponse} />
          )}
        </Card.Body>
      </Card>

      <DataTable
        columns={columns}
        data={filteredRows}
        pagination
        progressPending={loading}
        highlightOnHover
        pointerOnHover
        conditionalRowStyles={conditionalRowStyles}
        onRowClicked={(row) => fetchHeatmap(row)}
        dense
      />
    </Container>
  );
};

export default AlarmsOverview;
