import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Form, Spinner } from 'react-bootstrap';
import {
  Broadcast,
  ChevronDown,
  Clipboard,
  Cpu,
  DashLg,
  Terminal,
  Trash,
  X,
} from 'react-bootstrap-icons';
import DataTable, { type TableColumn } from 'react-data-table-component';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import usePermissions from '../../../hooks/usePermissions';
import axiosConfig from '../../axiosConfig';
import ConfirmDialog from '../ui/kit/ConfirmDialog';
import DeviceCommandsDialog from './DeviceCommandsDialog';
import {
  showErrorBar,
  showRequestError,
  showSuccessBar,
} from '../ui/Snackbar.jsx';
import { formatDate } from '../../main/dateFormat';
import { staffFlags } from '../../main/access';
import { repeatedTestId } from '../../testIds';
import './ProvisionTestMeasurements.css';

/** helper/device_commands.check_test_pairs (sensors numbered from 1). */
type TestCheck = {
  status: 'ok' | 'warn' | 'fail';
  rising: number;
  start: number | null;
  end: number | null;
  /** The single MUX the test segment belongs to (1-based), if detected. */
  mux: number | null;
  /** Signal outside the detected test segment: sensors and summed values. */
  noise: number;
  noise_sensors: number;
  /** 0-100: share of the total signal that lies inside the test segment. */
  quality: number;
  outliers: number[];
  reasons: string[];
};

/** A MUX the controller reports as answering with fewer channels than it has. */
type MuxFault = { mux: number; missing_channels: number };

/** A row of GET /v1/device/provision/test-measurements/. */
type TestMeasurement = {
  id: number;
  time: string | null;
  event?: string | null;
  count: number;
  max: number | null;
  pairs: number[];
  check: TestCheck;
  /** raw_data.mux_faults of the controller's sample - [] (or missing) without any. */
  mux_faults?: MuxFault[];
  /** The pairs as a bar chart (data URL, 150 px high, at most 600 wide). */
  png: string;
};

type TestState = {
  measurements: TestMeasurement[];
  expected_rising: number;
  /** Sensors the controller reports (latest measurement or provisioning). */
  sensor_count?: number;
  /** MUXes of the controller (16 sensors each) - the choices of "Emulate Measurement". */
  mux_count: number;
  pending_commands: string[];
  last_command_poll: string | null;
};

/** A MUX carries 16 sensor pairs. */
const MUX_SENSORS = 16;

/** How often the list is fetched while the card is open. */
const POLL_MS = 5000;
/** The backend's TEST_MEASUREMENTS_LIMIT - the list never grows beyond it. */
const TEST_MEASUREMENTS_LIMIT = 50;

const STATUS: Record<TestCheck['status'], { bg: string; label: string }> = {
  ok: { bg: 'success', label: 'OK' },
  warn: { bg: 'warning', label: 'Check' },
  fail: { bg: 'danger', label: 'Failed' },
};

const formatTime = (value: string | null) => formatDate(value, 'dateTimeSeconds');

// The colours per state: .provision-mux-box--<state> (ProvisionTestMeasurements.css).
const MUX_BOX: Record<TestCheck['status'] | 'pending', { label: string }> = {
  ok: { label: 'OK' },
  warn: { label: 'Check' },
  fail: { label: 'Failed' },
  pending: { label: 'not tested' },
};

/** Floating status board of a running measurement-test session: one 100x100
 * box per MUX, coloured by its newest test measurement. */
const MuxStatusPanel = ({
  muxCount,
  measurements,
}: {
  muxCount: number;
  measurements: TestMeasurement[];
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [closed, setClosed] = useState(false);
  if (muxCount <= 0) {
    return null;
  }
  // Do not rely on the array order: the datatable sorts by time and the
  // incremental poll merges responses, so the newest measurement for a MUX is
  // not necessarily the first row in `measurements`. Pick by id (pk) instead.
  const newest = new Map<number, TestCheck>();
  const byNewest = [...measurements].sort((left, right) => right.id - left.id);
  // MUX faults of the newest measurement: the controller's current state.
  const faults = new Map<number, number>(
    (byNewest[0]?.mux_faults ?? []).map((fault) => [fault.mux, fault.missing_channels]),
  );
  byNewest.forEach((row) => {
      const mux = Number(row.check.mux);
      if (Number.isInteger(mux) && mux > 0 && !newest.has(mux)) {
        newest.set(mux, row.check);
      }
    });

  if (closed) {
    return (
      <button
        type="button"
        onClick={() => {
          setClosed(false);
          setCollapsed(false);
        }}
        title="Show MUX test status"
        className="provision-mux-reopen"
        data-testid="mux-status-reopen"
      >
        MUX test status · {newest.size}/{muxCount}
      </button>
    );
  }

  return (
    <div
      data-testid="mux-status-panel"
      className="provision-mux-panel"
    >
      <div className="provision-mux-header">
        <strong className="provision-mux-title">
          MUX test status
        </strong>
        <span className="provision-mux-count" data-testid="mux-status-count">
          {newest.size}/{muxCount} tested
        </span>
        <div className="provision-mux-header-actions">
          <button
            type="button"
            title={collapsed ? 'Expand' : 'Minimize'}
            aria-label={collapsed ? 'Expand MUX status' : 'Minimize MUX status'}
            onClick={() => setCollapsed((value) => !value)}
            className="provision-mux-header-button"
            data-testid="mux-status-collapse"
          >
            {collapsed ? <ChevronDown size={14} /> : <DashLg size={14} />}
          </button>
          <button
            type="button"
            title="Close"
            aria-label="Close MUX status"
            onClick={() => setClosed(true)}
            className="provision-mux-header-button"
            data-testid="mux-status-close"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="provision-mux-boxes">
          {Array.from({ length: muxCount }, (_, index) => {
            const mux = index + 1;
            const check = newest.get(mux);
            const missing = faults.get(mux);
            const state = missing != null ? 'fail' : (check?.status ?? 'pending');
            const style = MUX_BOX[state];
            return (
              <div
                key={mux}
                title={
                  missing != null
                    ? `MUX ${mux}: ${missing} channel(s) missing (reported by the controller)`
                    : `MUX ${mux}: ${style.label}`
                }
                className={`provision-mux-box provision-mux-box--${state}`}
                {...repeatedTestId('mux-status-box', mux)}
              >
                <strong className="provision-mux-box-name">MUX {mux}</strong>
                <span className="provision-mux-box-state">
                  {style.label}
                </span>
                {missing != null ? (
                  <span className="provision-mux-box-note provision-mux-box-note--strong">
                    {missing} ch missing
                  </span>
                ) : (
                  check && (
                    <span className="provision-mux-box-note">
                      {check.rising} rising
                    </span>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

type ProvisionTestMeasurementsProps = {
  /** pk of the location the device was provisioned for. */
  locationId: number;
  deviceId: number;
  deviceHash: string;
  /** Shows a close button (the device overview hides the panel). */
  onClose?: () => void;
};

/**
 * "Test-Messungen" of a freshly provisioned controller: polls its
 * measurements, checks each (16 rising sensors, the rest empty - see
 * helper/device_commands.py) and shows its pairs as a small chart. "Messung
 * anfragen" queues a measurement for the controller's next command poll
 * (sample/cc), "Test-Messungen bereinigen" deletes the listed ones.
 * Superusers can "Emulate Measurement": the backend POSTs a sample like the
 * controller's to its control.url - the chosen MUX rising, the rest 0.
 */
const ProvisionTestMeasurements = ({
  locationId,
  deviceId,
  deviceHash,
  onClose,
}: ProvisionTestMeasurementsProps) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const { hasPermission } = usePermissions();
  // Controller commands (sample/cc) - staff or module_devices_commands, like the device overview.
  const [showCommands, setShowCommands] = useState(false);
  const { isStaffOrSuperuser } = staffFlags(auth?.user);
  const canCommands = isStaffOrSuperuser || hasPermission('module_devices_commands');
  const [state, setState] = useState<TestState | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [mux, setMux] = useState(1);
  const [emulating, setEmulating] = useState(false);
  const { isSuperuser } = staffFlags(auth?.user);
  // Only report a failing poll once, not every POLL_MS.
  const pollFailed = useRef(false);
  // Newest measurement timestamp already merged into the table. After the
  // first full fetch every poll asks only for rows newer than this.
  const knownSince = useRef<string | null>(null);

  const load = useCallback(() => {
    const since = knownSince.current
      ? `&know_since=${encodeURIComponent(knownSince.current)}`
      : '';
    void axiosConfig.perform_get(
      auth,
      `/v1/device/provision/test-measurements/?location=${locationId}&device=${deviceId}${since}`,
      (response) => {
        pollFailed.current = false;
        const data = (response?.data || null) as TestState | null;
        if (!data) {
          return;
        }
        const incoming = data.measurements ?? [];
        const newest = incoming[0];
        setState((current) => {
          if (!current) {
            return data;
          }
          // Incremental polls return only new rows - merge them newest first.
          const byId = new Map<number, TestMeasurement>();
          [...incoming, ...current.measurements].forEach((row) => {
            if (!byId.has(row.id)) {
              byId.set(row.id, row);
            }
          });
          return {
            ...current,
            ...data,
            measurements: [...byId.values()].slice(0, TEST_MEASUREMENTS_LIMIT),
          };
        });
        if (newest?.time) {
          knownSince.current = newest.time;
        }
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
    knownSince.current = null;
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

  const emulateMeasurement = () => {
    setEmulating(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/device/provision/emulate-measurement/',
      { location: locationId, device: deviceId, mux },
      () => {
        setEmulating(false);
        showSuccessBar(enqueueSnackbar, `Measurement of MUX-${mux} emulated.`);
        load();
      },
      (error) => {
        showRequestError(
          enqueueSnackbar,
          'Could not emulate a measurement',
          error,
        );
        setEmulating(false);
      },
    );
  };

  const measurements = state?.measurements ?? [];
  // Existing controllers can have more sensors than their provisioning token;
  // the measurements are the authoritative count (444 sensors = 28 MUXes).
  const measuredSensors = measurements.reduce(
    (maximum, row) => Math.max(maximum, row.count),
    0,
  );
  const muxCount = Math.max(
    state?.mux_count ?? 1,
    Math.ceil((state?.sensor_count ?? measuredSensors) / MUX_SENSORS),
    Math.ceil(measuredSensors / MUX_SENSORS),
  );

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
        // Forget the cursor too - the next fetch is a full (empty) list.
        knownSince.current = null;
        setState((current) =>
          current ? { ...current, measurements: [] } : current,
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

  const copyMeasurement = (row: TestMeasurement) => {
    const text = row.pairs.join(', ');
    if (!navigator.clipboard?.writeText) {
      showErrorBar(enqueueSnackbar, 'Clipboard is not available in this browser.');
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => showSuccessBar(enqueueSnackbar, 'Measurement data copied to the clipboard.'),
      () => showErrorBar(enqueueSnackbar, 'Could not copy the measurement data.'),
    );
  };

  const columns: TableColumn<TestMeasurement>[] = [
    {
      id: 'time',
      name: 'Time',
      selector: (row) => row.time ?? '',
      sortable: true,
      cell: (row) => (
        <div className="small" {...repeatedTestId('provision-test-measurement', row.id)}>
          {formatTime(row.time)}
          {row.event && <div className="text-muted">{row.event}</div>}
        </div>
      ),
      width: '150px',
    },
    {
      id: 'check',
      name: 'Check',
      selector: (row) => row.check.status,
      sortable: true,
      cell: (row) => (
        <div className="small py-2">
          <Badge bg={STATUS[row.check.status].bg} {...repeatedTestId('provision-test-check', row.id)}>
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
          {(row.mux_faults ?? []).map((fault) => (
            <div key={fault.mux} className="text-danger fw-semibold">
              MUX {fault.mux}: {fault.missing_channels} channel(s) missing
            </div>
          ))}
        </div>
      ),
      width: '220px',
      wrap: true,
    },
    {
      id: 'mux',
      name: 'MUX',
      selector: (row) => row.check.mux ?? 0,
      sortable: true,
      cell: (row) =>
        row.check.mux ? (
          <Badge bg="primary">MUX {row.check.mux}</Badge>
        ) : (
          <span className="text-muted">–</span>
        ),
      width: '86px',
    },
    {
      id: 'quality',
      name: 'Quality',
      selector: (row) => row.check.quality,
      sortable: true,
      cell: (row) => {
        const quality = row.check.quality;
        const bg =
          quality >= 95
            ? 'success'
            : quality >= 80
              ? 'info'
              : quality >= 60
                ? 'warning'
                : 'danger';
        return (
          <Badge bg={bg} text={bg === 'warning' ? 'dark' : undefined}>
            {quality}%
          </Badge>
        );
      },
      width: '90px',
    },
    {
      id: 'noise',
      name: 'Noise',
      selector: (row) => row.check.noise,
      sortable: true,
      cell: (row) => (
        <div
          className="small"
          title={`Sum of values outside the test segment: ${row.check.noise}`}
        >
          {row.check.noise_sensors} sensors
          <div className="text-muted">Σ {row.check.noise}</div>
        </div>
      ),
      width: '110px',
    },
    {
      id: 'sensors',
      name: 'Sensors',
      selector: (row) => row.count,
      sortable: true,
      cell: (row) => (
        <div className="small">
          {row.count}
          <div className="text-muted">max {row.max ?? '-'}</div>
        </div>
      ),
      width: '90px',
    },
    {
      id: 'pairs',
      name: 'Pairs',
      selector: (row) => row.pairs.length,
      sortable: true,
      cell: (row) => (
        <img
          src={row.png}
          alt={`Pairs: ${row.pairs.join(', ')}`}
          title={row.pairs.join(', ')}
          className="provision-test-pairs my-2"
        />
      ),
      minWidth: '200px',
      grow: 3,
    },
    {
      id: 'copy',
      name: '',
      button: true,
      sortable: false,
      cell: (row) => (
        <Button
          size="sm"
          variant="outline-secondary"
          className="py-0"
          title="Copy measurement data to the clipboard"
          aria-label="Copy measurement data to the clipboard"
          onClick={() => copyMeasurement(row)}
          {...repeatedTestId('provision-test-copy', row.id)}
        >
          <Clipboard size={14} />
        </Button>
      ),
      width: '54px',
    },
  ];

  return (
    <>
      {state && (
        <MuxStatusPanel muxCount={muxCount} measurements={measurements} />
      )}
      <Card className="border-0 shadow-sm p-3 mt-3" data-testid="provision-test">
        <Card.Body>
        <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
          <h5 className="mb-0 me-auto">Test-Messungen</h5>
          {isSuperuser && (
            <>
              <Form.Select
                aria-label="MUX"
                value={mux}
                onChange={(event) => setMux(Number(event.target.value))}
                disabled={emulating}
                className="provision-test-mux"
                data-testid="provision-test-mux"
              >
                {Array.from(
                  { length: Math.max(muxCount, mux) },
                  (_, index) => (
                    <option key={index + 1} value={index + 1}>
                      MUX-{index + 1}
                    </option>
                  ),
                )}
              </Form.Select>
              <Button
                variant="outline-secondary"
                onClick={emulateMeasurement}
                disabled={emulating}
                data-testid="provision-test-emulate"
              >
                {emulating ? (
                  <Spinner size="sm" animation="border" className="me-2" />
                ) : (
                  <Cpu className="me-2" />
                )}
                Emulate Measurement
              </Button>
            </>
          )}
          <Button
            variant="outline-primary"
            onClick={requestMeasurement}
            disabled={requesting}
            data-testid="provision-test-request"
          >
            {requesting ? (
              <Spinner size="sm" animation="border" className="me-2" />
            ) : (
              <Broadcast className="me-2" />
            )}
            Messung anfragen
          </Button>
          {canCommands && (
            <Button variant="outline-primary" onClick={() => setShowCommands(true)} data-testid="provision-test-commands">
              <Terminal className="me-2" />
              {t('devices_action_commands')}
            </Button>
          )}
          {isSuperuser && (
            <Button
              variant="outline-danger"
              onClick={() => setConfirmClear(true)}
              disabled={!measurements.length || clearing}
              data-testid="provision-test-clear"
            >
              <Trash className="me-2" />
              Test-Messungen bereinigen
            </Button>
          )}
          {onClose && (
            <Button variant="link" size="sm" className="p-0 ms-1" onClick={onClose} data-testid="provision-test-close">
              {t('provision_add_close')}
            </Button>
          )}
        </div>

        <div className="small text-muted mb-3" data-testid="provision-test-status">
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
          <div className="d-flex align-items-center gap-2 text-muted py-3" data-testid="provision-test-loading">
            <Spinner size="sm" animation="border" /> Loading…
          </div>
        ) : measurements.length === 0 ? (
          <Alert variant="light" className="mb-0" data-testid="provision-test-empty">
            No measurements yet - power the controller on or request a
            measurement.
          </Alert>
        ) : (
          <DataTable
            columns={columns}
            data={measurements}
            dense
            defaultSortFieldId="time"
            defaultSortAsc={false}
          />
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
          testId="provision-test-clear-dialog"
        />
        </Card.Body>
      </Card>
      {showCommands && (
        <DeviceCommandsDialog
          device={{ id: deviceId, location: locationId, raw_hash: deviceHash }}
          isSuperuser={isSuperuser}
          canEdit={canCommands}
          onClose={() => setShowCommands(false)}
          testId="provision-test-commands-dialog"
        />
      )}
    </>
  );
};

export default ProvisionTestMeasurements;
