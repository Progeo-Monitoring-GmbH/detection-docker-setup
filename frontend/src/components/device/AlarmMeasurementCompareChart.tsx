import { useState } from 'react';
import { Button, Card, Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../../hooks/CoreAuthProvider.tsx';
import {
  alarmStartTime,
  isAlarmActive,
  parseTimestamp,
  type TimelineAlarm,
} from '../../main/alarmUtils';
import axiosConfig from '../../axiosConfig.tsx';
import { showErrorBar } from '../ui/Snackbar.jsx';
import MeasurementSamplesCompareChart, {
  type MeasurementCompareRow,
} from './MeasurementSamplesCompareChart.tsx';

/** Measurements are loaded for triggered_at ± this window. */
const ALARM_WINDOW_MS = 6 * 60 * 60 * 1000;

/** ms -> naive local ISO string (matches the backend from/to params). */
const toLocalIso = (ms: number): string => {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
};

type AlarmMeasurementCompareChartProps = {
  alarm: TimelineAlarm;
};

/**
 * Lazy wrapper around MeasurementSamplesCompareChart for a single alarm.
 *
 * Initially it only shows a "Show Measurements" button. On click it loads the
 * alarm device's measurements for triggered_at ± 6h and plots them; a red
 * transparent band spans the whole alarm duration (start -> normalized/now).
 */
const AlarmMeasurementCompareChart = ({
  alarm,
}: AlarmMeasurementCompareChartProps) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<MeasurementCompareRow[]>([]);
  const [alarmStart, setAlarmStart] = useState<number | null>(null);
  const [alarmDuration, setAlarmDuration] = useState<number | null>(null);

  const deviceId = alarm.device?.id ?? null;
  const startMs = alarmStartTime(alarm);

  const loadMeasurements = () => {
    if (deviceId == null) {
      showErrorBar(
        enqueueSnackbar,
        'Alarm has no device to load measurements for.',
      );
      return;
    }
    if (startMs == null) {
      showErrorBar(
        enqueueSnackbar,
        'Alarm has no trigger time to center the measurement window on.',
      );
      return;
    }

    // Alarm duration: normalized_at marks the end; still-active alarms run
    // until "now" (captured when the measurements are loaded).
    const normalizedMs = parseTimestamp(alarm.normalized_at);
    const endMs =
      normalizedMs ?? (isAlarmActive(alarm) ? Date.now() : startMs);
    const durationMs = Math.max(0, endMs - startMs);

    setLoading(true);
    const params = new URLSearchParams({
      from: toLocalIso(startMs - ALARM_WINDOW_MS),
      to: toLocalIso(startMs + ALARM_WINDOW_MS),
      limit: '2000',
    });

    void axiosConfig.perform_get(
      auth,
      `/v1/device/${deviceId}/measurements/?${params.toString()}`,
      (response) => {
        setRows((response?.data?.measurements || []) as MeasurementCompareRow[]);
        setAlarmStart(startMs);
        setAlarmDuration(durationMs);
        setLoading(false);
        setOpen(true);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not load measurements: ${reason}`);
        setLoading(false);
      },
    );
  };

  return (
    <Card className="border-0 shadow-sm p-3">
      <Card.Body>
        {!open ? (
          <div className="text-center py-3">
            <Button
              variant="outline-primary"
              onClick={loadMeasurements}
              disabled={loading}
            >
              {loading ? (
                <>
                  <Spinner size="sm" animation="border" className="me-2" />
                  Loading measurements...
                </>
              ) : (
                'Show Measurements'
              )}
            </Button>
          </div>
        ) : (
          <>
            <div className="d-flex flex-wrap justify-content-between align-items-center mb-2 gap-2">
              <small className="text-muted">
                Measurements of device #{deviceId} around the alarm start ±6h
              </small>
              <Button
                size="sm"
                variant="outline-secondary"
                onClick={loadMeasurements}
                disabled={loading}
              >
                {loading ? 'Loading...' : 'Reload'}
              </Button>
            </div>
            {rows.length === 0 ? (
              <div className="text-muted py-4 text-center">
                No measurements found in the ±6h window.
              </div>
            ) : (
              <MeasurementSamplesCompareChart
                rows={rows}
                alarmStartTime={alarmStart}
                alarmDurationMs={alarmDuration}
              />
            )}
          </>
        )}
      </Card.Body>
    </Card>
  );
};

export default AlarmMeasurementCompareChart;
