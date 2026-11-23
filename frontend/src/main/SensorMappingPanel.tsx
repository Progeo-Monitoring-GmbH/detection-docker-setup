import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Form, Spinner } from 'react-bootstrap';
import { ArrowCounterclockwise, Diagram3, Save } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import type { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import PillButton from '../components/ui/kit/PillButton';
import SearchableDataTable, { type SearchableColumn } from '../components/ui/kit/SearchableDataTable';
import { showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import { formatDate } from './dateFormat';
import './SensorMappingPanel.css';

type Auth = ReturnType<typeof useAuth>;

/** Where an input's sensor number comes from (helper/sensor_mapping.py effective). */
export type InputSource = 'formula' | 'manual' | 'klemmliste' | 'merge' | 'mapped';

export type MappingInput = { position: number; sensor_order: number | null; source: InputSource };

/** GET/POST /v1/status/measure_points/sensor_mapping/. */
export type SensorMappingAnswer = {
  device_id: number;
  first_sensor_order: number | null;
  sensor_count: number | null;
  inputs: MappingInput[];
  versions: {
    id: number;
    valid_from: string;
    origin: 'klemmliste' | 'manual' | 'formula' | 'merge';
    source_name: string;
    mapped: boolean;
    inputs: number;
    manual: number[];
  }[];
};

const SOURCE_LABEL: Record<InputSource, string> = {
  formula: 'formula',
  manual: 'by hand',
  klemmliste: 'Klemmliste',
  merge: 'merge',
  mapped: 'mapped',
};

const ORIGIN_LABEL: Record<SensorMappingAnswer['versions'][number]['origin'], string> = {
  klemmliste: 'Klemmliste',
  manual: 'by hand',
  formula: 'back to the formula',
  merge: 'merge',
};

const URL = '/v1/status/measure_points/sensor_mapping/';

/** The answer with its lists always present (an unexpected answer shows as empty). */
export const asAnswer = (data: unknown): SensorMappingAnswer | null => {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const answer = data as Partial<SensorMappingAnswer>;
  return {
    device_id: answer.device_id ?? 0,
    first_sensor_order: answer.first_sensor_order ?? null,
    sensor_count: answer.sensor_count ?? null,
    inputs: Array.isArray(answer.inputs) ? answer.inputs : [],
    versions: Array.isArray(answer.versions) ? answer.versions : [],
  };
};

type Draft = { draft: Record<number, string>; setNumber: (position: number, value: string) => void };

/** The typed numbers - read by the cells, so the columns stay the same while typing (focus kept). */
const DraftContext = createContext<Draft>({ draft: {}, setNumber: () => undefined });

const SensorCell = ({ row }: { row: MappingInput }) => {
  const { draft, setNumber } = useContext(DraftContext);
  return (
    <Form.Control
      size="sm"
      className="sensor-mapping-input"
      inputMode="numeric"
      value={row.position in draft ? draft[row.position] : (row.sensor_order ?? '').toString()}
      placeholder="none"
      onChange={(event) => setNumber(row.position, event.target.value.replace(/\D/g, ''))}
      aria-label={`Sensor of input ${row.position}`}
      data-testid="sensor-mapping-input"
      data-test-key={row.position}
    />
  );
};

/**
 * Which sensor each input of a device measures (backend helper/sensor_mapping.py):
 * by default first sensor + input - 1, else the mapping the Klemmliste wrote
 * or staff set by hand. Staff correct single inputs here - a new version from
 * now on, measurements before keep their meaning. An empty number: no sensor
 * on that input (its values are left out, it never alarms).
 */
const SensorMappingPanel = ({
  auth,
  locationId,
  devices,
  staff,
  revision = 0,
}: {
  auth: Auth;
  /** The location's project id (measure_points' location_id). */
  locationId: number;
  devices: { id: number; label: string }[];
  staff: boolean;
  /** Bumped when the Klemmliste wrote a mapping: read again. */
  revision?: number;
}) => {
  const { enqueueSnackbar } = useSnackbar();
  // Read through a ref: loading must not depend on the snackbar function's identity.
  const snackbar = useRef(enqueueSnackbar);
  snackbar.current = enqueueSnackbar;
  const [deviceId, setDeviceId] = useState<number | null>(devices[0]?.id ?? null);
  const [answer, setAnswer] = useState<SensorMappingAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Edited inputs: their new number as typed ('' = no sensor).
  const [draft, setDraft] = useState<Record<number, string>>({});

  const load = useCallback(() => {
    if (deviceId == null) {
      return;
    }
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      `${URL}?location_id=${locationId}&device_id=${deviceId}`,
      (response) => {
        setAnswer(asAnswer(response?.data));
        setDraft({});
        setLoading(false);
      },
      (error) => {
        setLoading(false);
        showRequestError(snackbar.current, 'The sensor mapping could not be read', error);
      },
    );
  }, [auth, deviceId, locationId]);

  useEffect(() => {
    load();
  }, [load, revision]);

  const post = (body: Record<string, unknown>, message: string) => {
    setSaving(true);
    void axiosConfig.perform_post(
      auth,
      URL,
      { location_id: locationId, device_id: deviceId, ...body },
      (response) => {
        setSaving(false);
        setAnswer(asAnswer(response?.data));
        setDraft({});
        showSuccessBar(enqueueSnackbar, message);
      },
      (error) => {
        setSaving(false);
        showRequestError(enqueueSnackbar, 'The sensor mapping could not be saved', error);
      },
    );
  };

  const changes = useMemo(() => {
    const result: Record<string, number | null> = {};
    (answer?.inputs ?? []).forEach((input) => {
      if (!(input.position in draft)) {
        return;
      }
      const typed = draft[input.position].trim();
      const next = typed === '' ? null : Number(typed);
      if (next !== input.sensor_order) {
        result[String(input.position)] = next;
      }
    });
    return result;
  }, [answer, draft]);
  const changeCount = Object.keys(changes).length;

  const columns = useMemo<SearchableColumn<MappingInput>[]>(
    () => [
      {
        id: 'position',
        name: 'Input',
        selector: (row) => row.position,
        sortable: true,
        width: '90px',
        cell: (row) => <strong>{row.position}</strong>,
      },
      {
        id: 'sensor',
        name: 'Sensor',
        selector: (row) => row.sensor_order ?? 0,
        sortable: true,
        searchText: (row) => (row.sensor_order == null ? 'none' : String(row.sensor_order)),
        cell: (row) => (staff ? <SensorCell row={row} /> : <strong>{row.sensor_order ?? '–'}</strong>),
      },
      {
        id: 'source',
        name: 'From',
        selector: (row) => row.source,
        sortable: true,
        searchText: (row) => SOURCE_LABEL[row.source],
        cell: (row) => (
          <Badge
            bg={row.source === 'formula' ? 'light' : row.source === 'manual' ? 'warning' : 'info'}
            text="dark"
            data-testid="sensor-mapping-source"
            data-test-key={row.position}
          >
            {SOURCE_LABEL[row.source]}
          </Badge>
        ),
      },
    ],
    [staff],
  );
  const draftValue = useMemo<Draft>(
    () => ({ draft, setNumber: (position, value) => setDraft((current) => ({ ...current, [position]: value })) }),
    [draft],
  );

  if (devices.length === 0) {
    return null;
  }
  const mapped = (answer?.inputs ?? []).some((input) => input.source !== 'formula');

  return (
    <div className="lageplan-klemmliste-section sensor-mapping" data-testid="sensor-mapping-panel">
      <div className="lageplan-klemmliste-section-head">
        <span className="lageplan-klemmliste-section-title">
          <Diagram3 size={14} className="me-1" />
          Sensor mapping
        </span>
        <span className="lageplan-klemmliste-actions">
          {devices.length > 1 && (
            <Form.Select
              size="sm"
              className="sensor-mapping-device"
              value={deviceId ?? ''}
              onChange={(event) => setDeviceId(Number(event.target.value))}
              aria-label="Device of the sensor mapping"
              data-testid="sensor-mapping-device"
            >
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.label}
                </option>
              ))}
            </Form.Select>
          )}
          {staff && (
            <>
              <PillButton
                icon={saving ? <Spinner animation="border" size="sm" /> : <Save size={13} />}
                label={`Save ${changeCount} change(s)`}
                onClick={() => post({ changes }, `${changeCount} input(s) corrected - from now on`)}
                disabled={saving || changeCount === 0}
                testId="sensor-mapping-save"
              />
              {mapped && (
                <PillButton
                  variant="ghost"
                  icon={<ArrowCounterclockwise size={13} />}
                  label="Back to the formula"
                  onClick={() => post({ reset: true }, 'The device counts by the formula again - from now on')}
                  disabled={saving}
                  testId="sensor-mapping-reset"
                />
              )}
            </>
          )}
        </span>
      </div>
      <div className="lageplan-klemmliste-note">
        Which sensor each input of the device measures. By default input <strong>n</strong> is sensor{' '}
        <strong>{answer?.first_sensor_order ?? 1} + n - 1</strong>; the Klemmliste (strategy &quot;sensor mapping&quot;)
        or a correction here overrides it. Changes count <strong>from now on</strong> - earlier measurements keep their
        meaning. An empty number: no sensor on that input.
      </div>
      {loading && !answer ? (
        <div className="lageplan-klemmliste-note">
          <Spinner animation="border" size="sm" className="me-2" />
          Loading the mapping…
        </div>
      ) : answer && answer.inputs.length === 0 ? (
        <div className="lageplan-klemmliste-note" data-testid="sensor-mapping-empty">
          The device has no sensor count yet - read its Klemmliste first.
        </div>
      ) : answer ? (
        <DraftContext.Provider value={draftValue}>
          <SearchableDataTable<MappingInput, number>
            columns={columns}
            data={answer.inputs}
            dense
            keyField="position"
            testId="sensor-mapping-table"
            mobileColumns={['position', 'sensor']}
            pagination={answer.inputs.length > 50}
            paginationPerPage={50}
          />
        </DraftContext.Provider>
      ) : null}
      {answer && answer.versions.length > 0 && (
        <ul className="sensor-mapping-versions" data-testid="sensor-mapping-versions">
          {answer.versions.slice(0, 5).map((version) => (
            <li key={version.id}>
              From <strong>{formatDate(version.valid_from)}</strong>: {ORIGIN_LABEL[version.origin]}
              {version.source_name ? ` (${version.source_name})` : ''}
              {version.mapped ? `, ${version.inputs} input(s)` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default SensorMappingPanel;
