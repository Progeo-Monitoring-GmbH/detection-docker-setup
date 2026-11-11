import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DataTable from 'react-data-table-component';
import type { TableColumn } from 'react-data-table-component';
import { Badge, Button, Card, Container, Form, Spinner } from 'react-bootstrap';
import {
  ArrowClockwise,
  Check2Circle,
  PlusLg,
  ThermometerHalf,
  Activity,
} from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import { FilterComponent } from '../components/ui/FilterComponent.jsx';
import SensorHeatmap2D from '../components/device/SensorHeatmap2D.tsx';
import {
  type HeatProfile,
  heatProfileQuery,
  type SensorHeatmapResponse,
} from '../components/device/sensorHeatmapTypes';
import AlarmMeasurementCompareChart from '../components/device/AlarmMeasurementCompareChart.tsx';
import AlarmTimeline, {
  alarmKey,
  alarmStartTime,
  formatDuration,
  isAlarmActive,
  parseTimestamp,
} from './AlarmTimeline.tsx';
import { type RainEvent, rainEventKey } from './alarmUtils';
import { formatDate, toLocalIso } from './dateFormat';

type AlarmDevice = {
  id?: number | null;
  mac?: string | null;
  raw_hash?: string | null;
  /** mac (custom name), else hardware, else raw_hash - see ProgeoDevice.display_name. */
  display_name?: string | null;
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
  /** alarmKey() - the table's row key (ids repeat across project databases). */
  _key?: string;
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
// Default alarm window: the backend also defaults to 7 days, but passing it
// explicitly keeps the overview bounded even if the backend default changes.
const DEFAULT_ALARM_DAYS = 3;
// Selectable window sizes for the days select-box (older alarms are fetched
// incrementally, one missing slice at a time).
const DAY_OPTIONS = [1, 2, 3, 7, 14, 30, 90, 365];
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Convert a ms timestamp to a naive local ISO string (no timezone suffix),
 * matching the format the backend serializer emits, so `from`/`to` round-trip
 * through datetime.fromisoformat on the server.
 */

// ProgeoAlarm.Status -> i18n key and badge colour.
const STATUS_LABELS: Record<number, { labelKey: string; variant: string }> = {
  0: { labelKey: 'alarm_status_new', variant: 'warning' },
  1: { labelKey: 'alarm_status_acknowledged', variant: 'secondary' },
  2: { labelKey: 'alarm_status_fault', variant: 'danger' },
};

const AlarmsOverview = () => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const [rows, setRows] = useState<AlarmRow[]>([]);
  // Rain events of the alarms' locations (ProgeoRainEvent) - timeline only.
  const [rainEvents, setRainEvents] = useState<RainEvent[]>([]);
  const [loading, setLoading] = useState(false);
  // Select-box value: the step size for "Load more" and the initial window.
  const [days, setDays] = useState(DEFAULT_ALARM_DAYS);
  // How many days are currently covered by `rows` (0 = nothing loaded yet).
  const [loadedDays, setLoadedDays] = useState(0);
  const [selectedAlarm, setSelectedAlarm] = useState<AlarmRow | null>(null);
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [heatmapResponse, setHeatmapResponse] =
    useState<SensorHeatmapResponse | null>(null);
  // Staff: the heat's value per sensor; switching it keeps the shown
  // heatmap until the other one arrives.
  const [heatProfile, setHeatProfile] = useState<HeatProfile>('diff');
  const [profileLoading, setProfileLoading] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const [onlyLastHour, setOnlyLastHour] = useState(false);
  // alarmKey() - ids repeat across project databases.
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);
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

  // Fetch a specific time window [fromMs, toMs]. When `merge` is true the
  // returned alarms are added to the existing rows (deduplicated by id) so
  // older alarms can be loaded incrementally without re-fetching the whole
  // window; otherwise the rows are replaced.
  const fetchWindow = useCallback(
    (fromMs: number, toMs: number, merge: boolean, onSuccess?: () => void) => {
      setLoading(true);
      const params = new URLSearchParams({
        from: toLocalIso(fromMs),
        to: toLocalIso(toMs),
      });
      void axiosConfig.perform_get(
        auth,
        `/v1/alarm/?${params.toString()}`,
        (response) => {
          const incoming = (response?.data?.alarms || []) as AlarmRow[];
          const incomingRain = (response?.data?.rain_events || []) as RainEvent[];
          setRainEvents((prev) => {
            if (!merge) {
              return incomingRain;
            }
            // A rain event can span both loaded windows: keep it once.
            const map = new Map(prev.map((event) => [rainEventKey(event), event]));
            for (const event of incomingRain) {
              map.set(rainEventKey(event), event);
            }
            return [...map.values()];
          });
          setRows((prev) => {
            if (!merge) {
              return incoming;
            }
            const map = new Map<number, AlarmRow>();
            for (const row of prev) {
              map.set(row.id, row);
            }
            for (const row of incoming) {
              map.set(row.id, row); // incoming wins on duplicate ids
            }
            return [...map.values()];
          });
          setLoading(false);
          onSuccess?.();
        },
        (error) => {
          showRequestError(enqueueSnackbar, t('alarm_detail_load_alarms_failed'), error);
          setLoading(false);
        },
      );
    },
    [auth, enqueueSnackbar, t],
  );

  // Grow the covered window to `targetDays` by fetching only the missing,
  // older slice [now - targetDays, now - loadedDays] and appending it.
  const loadDays = useCallback(
    (targetDays: number) => {
      if (targetDays <= loadedDays) {
        return;
      }
      const nowMs = Date.now();
      fetchWindow(
        nowMs - targetDays * DAY_MS,
        nowMs - loadedDays * DAY_MS,
        true,
        () => setLoadedDays(targetDays),
      );
    },
    [fetchWindow, loadedDays],
  );

  // Shrink the covered window client-side (no fetch needed).
  const trimDays = useCallback((targetDays: number) => {
    const cutoff = Date.now() - targetDays * DAY_MS;
    setRows((prev) =>
      prev.filter((row) => {
        const start = alarmStartTime(row);
        return start == null || start >= cutoff;
      }),
    );
    setLoadedDays(targetDays);
  }, []);

  const handleDaysChange = (value: number) => {
    setDays(value);
    if (value > loadedDays) {
      loadDays(value);
    } else if (value < loadedDays) {
      trimDays(value);
    }
  };

  const loadMore = () => loadDays(loadedDays + days);

  const refresh = () => {
    const nowMs = Date.now();
    const currentDays = loadedDays > 0 ? loadedDays : days;
    fetchWindow(nowMs - currentDays * DAY_MS, nowMs, false);
  };

  // Initial load of the default window.
  useEffect(() => {
    loadDays(DEFAULT_ALARM_DAYS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchHeatmap = useCallback(
    (alarm: AlarmRow, profile: HeatProfile = heatProfile, profileSwitch = false) => {
      const locationId = alarm.location?.id;
      if (locationId == null) {
        showErrorBar(enqueueSnackbar, t('alarms_overview_no_location'));
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
      if (profileSwitch) {
        setProfileLoading(true);
      } else {
        setHeatmapLoading(true);
        setHeatmapResponse(null);
      }
      void axiosConfig.perform_get(
        auth,
        `/v1/location/${locationId}/heatmap/?${params.toString()}${heatProfileQuery(profile)}`,
        (result) => {
          setHeatmapResponse(
            (result?.data || null) as SensorHeatmapResponse | null,
          );
          setHeatmapLoading(false);
          setProfileLoading(false);
        },
        (error) => {
          showRequestError(enqueueSnackbar, t('alarms_overview_heatmap_failed'), error);
          setHeatmapResponse(null);
          setHeatmapLoading(false);
          setProfileLoading(false);
        },
      );
      if (profileSwitch) {
        return;
      }

      // Bring the heatmap card into view once the selection is made.
      window.setTimeout(() => {
        heatmapCardRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      }, 50);
    },
    [auth, enqueueSnackbar, heatProfile, now, t],
  );

  const acknowledgeAlarm = useCallback(
    (alarm: AlarmRow) => {
      setAcknowledgingId(alarmKey(alarm));
      void axiosConfig.perform_post(
        auth,
        // ?location=: alarm ids are only unique within one project database.
        `/v1/alarm/${alarm.id}/acknowledge/${alarm.location?.id ? `?location=${alarm.location.id}` : ''}`,
        {},
        (response) => {
          const updated = (response?.data?.alarms || null) as AlarmRow | null;
          if (updated) {
            setRows((prev) =>
              prev.map((row) =>
                row.id === updated.id && row.location?.id === updated.location?.id ? updated : row,
              ),
            );
          }
          showSuccessBar(enqueueSnackbar, t('alarms_overview_acknowledged_done', { id: alarm.id }));
          setAcknowledgingId(null);
        },
        (error) => {
          showRequestError(enqueueSnackbar, t('alarms_overview_acknowledge_failed'), error);
          setAcknowledgingId(null);
        },
      );
    },
    [auth, enqueueSnackbar, t],
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
        row.device?.display_name,
        row.device?.raw_hash,
        row.sensor_id != null ? String(row.sensor_id) : '',
        (Array.isArray(row.sensor_max_values) ? row.sensor_max_values : [])
          .map((pair) => String(pair.sensor_id ?? ''))
          .join(' '),
        isAlarmActive(row) ? 'active' : 'normalized',
        isAlarmActive(row) ? t('alarm_state_active') : t('alarm_state_normalized'),
        t((STATUS_LABELS[row.status ?? 0] || STATUS_LABELS[0]).labelKey),
        row.status === 1 ? 'acknowledged' : '',
        row.evaluated_by?.username,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return haystack.includes(needle);
    });
  }, [rows, filterText, onlyActive, onlyLastHour, now, t]);

  const tableRows = useMemo(
    () => filteredRows.map((row) => ({ ...row, _key: alarmKey(row) })),
    [filteredRows],
  );

  const columns: TableColumn<AlarmRow>[] = [
    {
      name: t('alarms_overview_col_id'),
      selector: (row) => row.id,
      sortable: true,
      width: '90px',
    },
    {
      name: t('alarm_detail_location'),
      cell: (row) => {
        const loc = row.location;
        return loc
          ? `${loc.name || t('alarms_overview_unnamed')} (${loc.project_id ?? loc.id})`
          : '-';
      },
      sortable: true,
      grow: 1.4,
      wrap: true,
    },
    {
      name: t('alarm_field_device'),
      cell: (row) => row.device?.display_name || row.device?.raw_hash || '-',
      sortable: true,
      grow: 1.2,
      wrap: true,
    },
    {
      name: t('alarm_field_sensors'),
      cell: (row) => {
        const pairs = Array.isArray(row.sensor_max_values)
          ? row.sensor_max_values
          : [];
        if (pairs.length === 0) {
          return row.sensor_id != null ? String(row.sensor_id) : '-';
        }
        return pairs.map((pair) => `#${pair.sensor_id ?? '-'}`).join(', ');
      },
      width: '160px',
      wrap: true,
    },
    {
      name: t('alarm_field_threshold'),
      selector: (row) => row.threshold ?? '-',
      width: '110px',
    },
    {
      name: t('alarm_field_max_value'),
      selector: (row) => row.max_value ?? '-',
      width: '110px',
    },
    {
      name: t('alarm_field_triggered'),
      cell: (row) => {
        const ms = alarmStartTime(row);
        return ms != null
          ? formatDate(ms)
          : row.triggered_at || '-';
      },
      sortable: true,
      width: '180px',
      wrap: true,
    },
    {
      name: t('alarm_field_active_for'),
      cell: (row) => formatDuration(alarmActiveDuration(row)),
      sortable: true,
      width: '140px',
    },
    {
      name: t('alarm_field_status'),
      cell: (row) => {
        const status = STATUS_LABELS[row.status ?? 0] || STATUS_LABELS[0];
        const active = isAlarmActive(row);
        const acknowledged = row.status === 1;
        return (
          <div className="d-flex flex-column gap-1">
            <div className="d-flex align-items-center gap-2">
              <Badge bg={active ? 'danger' : 'success'}>
                {active ? t('alarm_state_active') : t('alarm_state_normalized')}
              </Badge>
              <Badge bg={status.variant}>{t(status.labelKey)}</Badge>
            </div>
            {acknowledged && (
              <small className="text-muted">
                {t('alarms_overview_acknowledged_by', {
                  user: row.evaluated_by?.username || t('alarm_unknown_user'),
                })}{' '}
                ·{' '}
                {row.evaluated_at
                  ? (() => {
                      const ms = parseTimestamp(row.evaluated_at);
                      return ms != null
                        ? formatDate(ms)
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
      name: t('alarms_overview_col_actions'),
      width: '150px',
      cell: (row) => {
        const acknowledged = row.status === 1;
        return (
          <Button
            size="sm"
            variant={acknowledged ? 'outline-success' : 'success'}
            disabled={acknowledged || acknowledgingId === alarmKey(row)}
            title={
              acknowledged
                ? t('alarms_overview_already_acknowledged')
                : t('alarms_overview_acknowledge_hint')
            }
            onClick={(event) => {
              event.stopPropagation();
              acknowledgeAlarm(row);
            }}
          >
            {acknowledgingId === alarmKey(row) ? (
              <Spinner size="sm" animation="border" />
            ) : (
              <Check2Circle className="me-1" />
            )}
            {acknowledged ? t('ui_quittiert') : t('ui_quittieren')}
          </Button>
        );
      },
    },
  ];

  const conditionalRowStyles = [
    {
      when: (row: AlarmRow) => selectedAlarm !== null && alarmKey(row) === alarmKey(selectedAlarm),
      style: {
        backgroundColor: 'rgba(220, 53, 69, 0.10)',
        borderLeft: '3px solid #dc3545',
      },
    },
  ];

  const heatmapTitle = useMemo(() => {
    if (!selectedAlarm) {
      return t('alarms_overview_heatmap');
    }
    const loc = selectedAlarm.location;
    const where = loc
      ? `${loc.name || t('alarms_overview_unnamed')} (${loc.project_id ?? loc.id})`
      : t('alarms_overview_unknown_location');
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
        ? `${formatDate(startMs)} → ${formatDate(endMs)}`
        : '';
    return `${t('alarm_tooltip_title', { id: selectedAlarm.id })} - ${where}${range ? ` (${range})` : ''}`;
  }, [selectedAlarm, now, t]);

  const handleClearFilter = () => setFilterText('');

  return (
    <Container fluid className="py-4">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <div>
          <h2 className="mb-0">{t('alarms_overview_title')}</h2>
          <small className="text-muted">
            {t('alarms_overview_count', {
              shown: filteredRows.length,
              total: rows.length,
              days: loadedDays > 0 ? loadedDays : days,
            })}
          </small>
        </div>
        <div className="d-flex flex-wrap align-items-center gap-2">
          <Form.Check
            type="switch"
            id="alarms-only-active"
            label={t('alarms_overview_only_active')}
            checked={onlyActive}
            onChange={(event) => setOnlyActive(event.target.checked)}
            title={t('alarms_overview_only_active_hint')}
          />
          <Form.Check
            type="switch"
            id="alarms-only-last-hour"
            label={t('alarms_overview_last_hour')}
            checked={onlyLastHour}
            onChange={(event) => setOnlyLastHour(event.target.checked)}
            title={t('alarms_overview_last_hour_hint')}
          />
          <FilterComponent
            filterText={filterText}
            onFilter={(event) => setFilterText(event.target.value)}
            onClear={handleClearFilter}
          />
          <Form.Select
            size="sm"
            style={{ width: 'auto' }}
            aria-label={t('alarms_overview_window')}
            value={days}
            disabled={loading}
            onChange={(event) => handleDaysChange(Number(event.target.value))}
          >
            {DAY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {t('alarms_overview_days', { count: option })}
              </option>
            ))}
          </Form.Select>
          <Button
            variant="outline-secondary"
            onClick={loadMore}
            disabled={loading || loadedDays >= 365}
            title={t('alarms_overview_load_more_hint')}
          >
            <PlusLg className="me-2" />+{t('alarms_overview_days', { count: days })}
          </Button>
          <Button
            variant="outline-primary"
            onClick={refresh}
            disabled={loading}
          >
            <ArrowClockwise className="me-2" />
            {t('alarms_overview_refresh')}
          </Button>
        </div>
      </div>

      <Card className="border-0 shadow-sm mb-3 p-2">
        <Card.Body>
          <div className="d-flex flex-wrap justify-content-between align-items-center mb-2 gap-2">
            <h5 className="mb-0">{t('alarm_detail_timeline')}</h5>
            <small className="text-muted">
              {t('alarms_overview_timeline_hint')}
            </small>
          </div>
          <AlarmTimeline
            alarms={filteredRows}
            rainEvents={rainEvents}
            now={now}
            selectedAlarmKey={selectedAlarm ? alarmKey(selectedAlarm) : null}
            onSelectAlarm={(alarm) => fetchHeatmap(alarm)}
          />
        </Card.Body>
      </Card>

      <Card ref={heatmapCardRef} className="border-0 shadow-sm my-5 p-2">
        <Card.Body>
          <div className="d-flex flex-wrap justify-content-between align-items-center mb-2 gap-2">
            <h5 className="mb-0">
              <ThermometerHalf className="me-2 text-danger" />
              {heatmapTitle}
            </h5>
            <small className="text-muted">
              {t('alarms_overview_heatmap_hint')}
            </small>
          </div>

          {heatmapLoading ? (
            <div className="d-flex align-items-center gap-2 text-muted py-5 justify-content-center">
              <Spinner size="sm" animation="border" />
              {t('alarms_overview_heatmap_loading')}
            </div>
          ) : !selectedAlarm ? (
            <div className="text-muted py-5 text-center">
              {t('alarms_overview_heatmap_select')}
            </div>
          ) : (
            <>
              <SensorHeatmap2D
                response={heatmapResponse}
                profile={heatProfile}
                onProfileChange={(profile) => {
                  setHeatProfile(profile);
                  fetchHeatmap(selectedAlarm, profile, true);
                }}
                profileLoading={profileLoading}
              />
              <div className="d-flex flex-wrap justify-content-between align-items-center mb-2 gap-2">
                <h5 className="mb-0">
                  <Activity className="me-2 text-primary" />
                  {t('alarms_overview_measurements')}
                </h5>
                <small className="text-muted">{t('alarms_overview_measurements_hint')}</small>
              </div>
              {selectedAlarm ? (
                <AlarmMeasurementCompareChart alarm={selectedAlarm} />
              ) : (
                <div className="text-muted py-5 text-center">
                  {t('alarms_overview_measurements_select')}
                </div>
              )}
            </>
          )}
        </Card.Body>
      </Card>

      <DataTable
        columns={columns}
        data={tableRows}
        keyField="_key"
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
