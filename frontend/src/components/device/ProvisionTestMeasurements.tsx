import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Spinner } from 'react-bootstrap';
import { Broadcast, Trash } from 'react-bootstrap-icons';
import DataTable, { type TableColumn } from 'react-data-table-component';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import ConfirmDialog from '../ui/kit/ConfirmDialog';
import { showRequestError, showSuccessBar } from '../ui/Snackbar.jsx';

/** helper/device_commands.check_test_pairs (sensors numbered from 1). */
type TestCheck = {
  status: 'ok' | 'warn' | 'fail';
  rising: number;
  start: number | null;
  end: number | null;
  outliers: number[];
  reasons: string[];
};

/** A row of GET /v1/device/provision/test-measurements/. */
type TestMeasurement = {
  id: number;
  time: string | null;
  event?: string | null;
  count: number;
  max: number | null;
  pairs: number[];
  check: TestCheck;
  /** The pairs as a bar chart (data URL, 150 px high, at most 600 wide). */
  png: string;
};

type TestState = {
  measurements: TestMeasurement[];
  expected_rising: number;
  pending_commands: string[];
  last_command_poll: string | null;
};

/** How often the list is fetched while the card is open. */
const POLL_MS = 5000;

const STATUS: Record<TestCheck['status'], { bg: string; label: string }> = {
  ok: { bg: 'success', label: 'OK' },
  warn: { bg: 'warning', label: 'Check' },
  fail: { bg: 'danger', label: 'Failed' },
};

const formatTime = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: 'short',
        timeStyle: 'medium',
      })
    : '-';

type ProvisionTestMeasurementsProps = {
  /** pk of the location the device was provisioned for. */
  locationId: number;
  deviceId: number;
  deviceHash: string;
};

/**
 * "Test-Messungen" of a freshly provisioned controller: polls its
 * measurements, checks each (16 rising sensors, the rest empty - see
 * helper/device_commands.py) and shows its pairs as a small chart. "Messung
 * anfragen" queues a measurement for the controller's next command poll
 * (sample/cc), "Test-Messungen bereinigen" deletes the listed ones.
 */
const ProvisionTestMeasurements = ({
  locationId,
  deviceId,
  deviceHash,
}: ProvisionTestMeasurementsProps) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [state, setState] = useState<TestState | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  // Only report a failing poll once, not every POLL_MS.
  const pollFailed = useRef(false);

  const load = useCallback(() => {
    void axiosConfig.perform_get(
      auth,
      `/v1/device/provision/test-measurements/?location=${locationId}&device=${deviceId}`,
      (response) => {
        pollFailed.current = false;
        setState((response?.data || null) as TestState | null);
      },
      (error) => {
        if (!pollFailed.current) {
          showRequestError(
            enqueueSnackbar,
            'Could not load the test measurements',
            error,
          );
        }
        pollFailed.current = true;
      },
    );
  }, [auth, enqueueSnackbar, locationId, deviceId]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const requestMeasurement = () => {
    setRequesting(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/device/provision/request-measurement/',
      { location: locationId, device: deviceId },
      (response) => {
        const data = response?.data || {};
        setState((current) =>
          current
            ? {
                ...current,
                pending_commands:
                  data.pending_commands ?? current.pending_commands,
              }
            : current,
        );
        setRequesting(false);
        showSuccessBar(enqueueSnackbar, 'Measurement requested.');
      },
      (error) => {
        showRequestError(
          enqueueSnackbar,
          'Could not request a measurement',
          error,
        );
        setRequesting(false);
      },
    );
  };

  const measurements = state?.measurements ?? [];

  const clearMeasurements = () => {
    setClearing(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/device/provision/test-measurements/clear/',
      {
        location: locationId,
        device: deviceId,
        ids: measurements.map((row) => row.id),
      },
      (response) => {
        setClearing(false);
        setConfirmClear(false);
        showSuccessBar(
          enqueueSnackbar,
          `${response?.data?.deleted ?? 0} test measurement(s) deleted.`,
        );
        load();
      },
      (error) => {
        showRequestError(
          enqueueSnackbar,
          'Could not delete the test measurements',
          error,
        );
        setClearing(false);
      },
    );
  };

  const expected = state?.expected_rising ?? 16;
  const pending = (state?.pending_commands ?? []).includes('measure');

  const columns: TableColumn<TestMeasurement>[] = [
    {
      name: 'Time',
      selector: (row) => row.time ?? '',
      cell: (row) => (
        <div className="small">
          {formatTime(row.time)}
          {row.event && <div className="text-muted">{row.event}</div>}
        </div>
      ),
      width: '150px',
    },
    {
      name: 'Check',
      cell: (row) => (
        <div className="small py-2">
          <Badge bg={STATUS[row.check.status].bg}>
            {STATUS[row.check.status].label}
          </Badge>
          <div className="mt-1">
            {row.check.rising}/{expected} rising
            {row.check.start != null && row.check.rising > 0 && (
              <span className="text-muted">
                {' '}
                (S{row.check.start}–S{row.check.end})
              </span>
            )}
          </div>
          {row.check.reasons.map((reason) => (
            <div key={reason} className="text-muted">
              {reason}
            </div>
          ))}
        </div>
      ),
      width: '220px',
      wrap: true,
    },
    {
      name: 'Sensors',
      selector: (row) => row.count,
      cell: (row) => (
        <div className="small">
          {row.count}
          <div className="text-muted">max {row.max ?? '-'}</div>
        </div>
      ),
      width: '90px',
    },
    {
      name: 'Pairs',
      cell: (row) => (
        <img
          src={row.png}
          alt={`Pairs: ${row.pairs.join(', ')}`}
          title={row.pairs.join(', ')}
          style={{ height: 150, maxWidth: 600, display: 'block' }}
          className="my-2"
        />
      ),
      minWidth: '200px',
      grow: 3,
    },
  ];

  return (
    <Card className="border-0 shadow-sm p-3 mt-3">
      <Card.Body>
        <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
          <h5 className="mb-0 me-auto">Test-Messungen</h5>
          <Button
            variant="outline-primary"
            onClick={requestMeasurement}
            disabled={requesting}
          >
            {requesting ? (
              <Spinner size="sm" animation="border" className="me-2" />
            ) : (
              <Broadcast className="me-2" />
            )}
            Messung anfragen
          </Button>
          <Button
            variant="outline-danger"
            onClick={() => setConfirmClear(true)}
            disabled={!measurements.length || clearing}
          >
            <Trash className="me-2" />
            Test-Messungen bereinigen
          </Button>
        </div>

        <div className="small text-muted mb-3">
          Measurements of <code>{deviceHash}</code>, newest first - refreshed
          every {POLL_MS / 1000} s. Expected: {expected} sensors with rising
          values, every other sensor empty.{' '}
          {pending
            ? 'Measurement requested - waiting for the controller to poll its commands.'
            : state?.last_command_poll
              ? `Last command poll: ${formatTime(state.last_command_poll)}.`
              : 'The controller has not polled its commands yet.'}
        </div>

        {state === null ? (
          <div className="d-flex align-items-center gap-2 text-muted py-3">
            <Spinner size="sm" animation="border" /> Loading…
          </div>
        ) : measurements.length === 0 ? (
          <Alert variant="light" className="mb-0">
            No measurements yet - power the controller on or request a
            measurement.
          </Alert>
        ) : (
          <DataTable columns={columns} data={measurements} dense={false} />
        )}

        <ConfirmDialog
          show={confirmClear}
          title="Test-Messungen bereinigen"
          message={`Delete the ${measurements.length} listed test measurement(s) of ${deviceHash} - and any alarms they raised? This cannot be undone.`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          onConfirm={clearMeasurements}
          onCancel={() => setConfirmClear(false)}
          confirming={clearing}
        />
      </Card.Body>
    </Card>
  );
};

export default ProvisionTestMeasurements;
