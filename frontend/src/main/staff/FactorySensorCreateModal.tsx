import { useMemo, useState } from 'react';
import { Alert, Button, Form, Modal, Nav, Spinner } from 'react-bootstrap';
import DataTable, { type TableColumn } from 'react-data-table-component';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { progeoTableStyles } from '../../components/ui/kit/SearchableDataTable';
import { repeatedTestId } from '../../testIds';
import {
  fieldOfError,
  parseSensorCsv,
  SENSORS_URL,
  type FactorySensorInput,
} from './factorySensors';
import './FactorySensorsView.css';

type Mode = 'single' | 'csv';
const FIELDS = [
  'projekt',
  'sensor',
  'band',
  'tag_uid',
  'r_werk_ohm',
  'gemessen_am',
] as const;
type Field = (typeof FIELDS)[number];
type Draft = Record<Field, string>;

const EMPTY: Draft = {
  projekt: '',
  sensor: '',
  band: '',
  tag_uid: '',
  r_werk_ohm: '',
  gemessen_am: '',
};

/** The form as the POST body's row: empty -> null, R_Werk a number where it is one. */
const draftRow = (draft: Draft): FactorySensorInput => {
  const ohm = draft.r_werk_ohm.trim();
  // datetime-local: local time without a zone - sent as UTC.
  const measured = draft.gemessen_am ? new Date(draft.gemessen_am) : null;
  return {
    projekt: draft.projekt.trim(),
    sensor: draft.sensor.trim(),
    band: draft.band.trim() || null,
    tag_uid: draft.tag_uid.trim() || null,
    r_werk_ohm: /^\d+$/.test(ohm) ? Number(ohm) : ohm,
    gemessen_am:
      measured && !Number.isNaN(measured.getTime())
        ? measured.toISOString()
        : null,
  };
};

type ServerError = {
  message: string;
  index: number | null;
  field: string | null;
};

type Props = {
  /** Project and sensor to start with (from a measurement without factory values). */
  prefill?: Partial<Pick<Draft, 'projekt' | 'sensor'>>;
  onHide: () => void;
  onCreated: () => void;
};

/**
 * Creates factory values (R_Werk) of dm sensors through the factory app's
 * endpoint (POST /v1/werk/sensoren/, all or none): one in a form, or many
 * pasted in the import command's CSV format. A refused row/field is marked.
 */
const FactorySensorCreateModal = ({ prefill, onHide, onCreated }: Props) => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [mode, setMode] = useState<Mode>('single');
  const [draft, setDraft] = useState<Draft>({ ...EMPTY, ...prefill });
  const [csv, setCsv] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);

  const parsed = useMemo(() => parseSensorCsv(csv), [csv]);
  const csvErrorLines = useMemo(
    () => new Set(parsed.errors.map((item) => item.line)),
    [parsed],
  );
  const rows = mode === 'single' ? [draftRow(draft)] : parsed.rows;
  const canSend =
    !saving &&
    (mode === 'single'
      ? !!(
          draft.projekt.trim() &&
          draft.sensor.trim() &&
          draft.r_werk_ohm.trim()
        )
      : parsed.rows.length > 0 && parsed.errors.length === 0);

  const change = (field: Field, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setError(null);
  };

  const send = () => {
    setSaving(true);
    setError(null);
    axiosConfig.perform_post(
      auth,
      SENSORS_URL,
      { sensoren: rows },
      (response: { data: { angelegt: number; aktualisiert: number } }) => {
        setSaving(false);
        enqueueSnackbar(t('fs_saved', response.data), { variant: 'success' });
        onCreated();
      },
      (failure: {
        response?: { data?: { meldung?: string; feld?: string } };
        message?: string;
      }) => {
        setSaving(false);
        const data = failure?.response?.data;
        setError({
          message: data?.meldung || failure?.message || t('fs_save_failed'),
          ...fieldOfError(data?.feld),
        });
      },
    );
  };

  const invalid = (field: Field) =>
    mode === 'single' && error?.index === 0 && error.field === field;

  const input = (
    field: Field,
    props: { type?: string; required?: boolean; placeholder?: string } = {},
  ) => (
    <Form.Group className="fs-field" controlId={`fs-create-${field}`}>
      <Form.Label>
        {t(`fs_col_${field}`)}
        {props.required && ' *'}
      </Form.Label>
      <Form.Control
        type={props.type ?? 'text'}
        value={draft[field]}
        placeholder={props.placeholder}
        isInvalid={invalid(field)}
        onChange={(event) => change(field, event.target.value)}
        data-testid={`factory-sensor-create-${field}`}
      />
      {invalid(field) && (
        <Form.Control.Feedback type="invalid">
          {error?.message}
        </Form.Control.Feedback>
      )}
    </Form.Group>
  );

  const previewColumns = useMemo<TableColumn<FactorySensorInput>[]>(
    () => [
      {
        id: 'line',
        name: t('fs_col_line'),
        width: '64px',
        cell: (_row, index) => (
          <span
            {...repeatedTestId(
              'factory-sensor-create-preview-row',
              parsed.lines[index],
            )}
          >
            {parsed.lines[index]}
          </span>
        ),
      },
      {
        id: 'projekt',
        name: t('fs_col_projekt'),
        cell: (row) => <span className="fw-bold">{row.projekt}</span>,
      },
      {
        id: 'sensor',
        name: t('fs_col_sensor'),
        cell: (row) => <span className="fw-bold">{row.sensor}</span>,
      },
      {
        id: 'band',
        name: t('fs_col_band'),
        selector: (row) => row.band ?? '–',
      },
      {
        id: 'tag_uid',
        name: t('fs_col_tag_uid'),
        selector: (row) => row.tag_uid ?? '–',
      },
      {
        id: 'r_werk_ohm',
        name: t('fs_col_r_werk_ohm'),
        selector: (row) => String(row.r_werk_ohm),
      },
      {
        id: 'gemessen_am',
        name: t('fs_col_gemessen_am'),
        selector: (row) => row.gemessen_am ?? '–',
      },
    ],
    [parsed.lines, t],
  );

  return (
    <Modal
      show
      onHide={onHide}
      dialogClassName="fs-modal"
      data-testid="factory-sensor-create"
    >
      <Modal.Header closeButton>
        <Modal.Title>{t('fs_create_title')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Nav variant="tabs" activeKey={mode} className="mb-3">
          {(['single', 'csv'] as Mode[]).map((key) => (
            <Nav.Item key={key}>
              <Nav.Link
                as="button"
                eventKey={key}
                onClick={() => {
                  setMode(key);
                  setError(null);
                }}
                {...repeatedTestId('factory-sensor-create-tab', key)}
              >
                {t(`fs_create_tab_${key}`)}
              </Nav.Link>
            </Nav.Item>
          ))}
        </Nav>
        {mode === 'single' ? (
          <div className="fs-form">
            {input('projekt', { required: true, placeholder: '1500' })}
            {input('sensor', { required: true, placeholder: '000001' })}
            {input('band', { placeholder: '4711' })}
            {input('tag_uid', { placeholder: '04A1B2C3D4E5F6' })}
            {input('r_werk_ohm', { required: true, placeholder: '88120' })}
            {input('gemessen_am', { type: 'datetime-local' })}
          </div>
        ) : (
          <>
            <Form.Group controlId="fs-create-csv">
              <Form.Label>{t('fs_csv_hint')}</Form.Label>
              <Form.Control
                as="textarea"
                rows={6}
                className="fs-csv"
                value={csv}
                placeholder={
                  'projekt;sensor;band;tag_uid;r_werk_ohm;gemessen_am\n1500;1;4711;;88120;'
                }
                onChange={(event) => {
                  setCsv(event.target.value);
                  setError(null);
                }}
                data-testid="factory-sensor-create-csv"
              />
            </Form.Group>
            {parsed.rows.length > 0 && (
              <div
                className="fs-preview"
                data-testid="factory-sensor-create-preview"
              >
                <div className="fs-preview-summary">
                  {t('fs_csv_rows', { count: parsed.rows.length })}
                  {parsed.errors.length > 0 && (
                    <span className="text-danger ms-2">
                      {parsed.errors
                        .map((item) => t('fs_csv_error', item))
                        .join(' · ')}
                    </span>
                  )}
                </div>
                <DataTable
                  columns={previewColumns}
                  data={parsed.rows}
                  customStyles={progeoTableStyles}
                  dense
                  conditionalRowStyles={[
                    {
                      when: (row) => {
                        const index = parsed.rows.indexOf(row);
                        return (
                          csvErrorLines.has(parsed.lines[index]) ||
                          error?.index === index
                        );
                      },
                      classNames: ['fs-preview-error'],
                    },
                  ]}
                />
              </div>
            )}
          </>
        )}
        {error && !invalid(error.field as Field) && (
          <Alert
            variant="danger"
            className="mt-3 mb-0"
            data-testid="factory-sensor-create-error"
          >
            {error.index != null && mode === 'csv' && (
              <span className="fw-bold">
                {t('fs_csv_line', { line: parsed.lines[error.index] })}{' '}
              </span>
            )}
            {error.message}
          </Alert>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline-secondary" onClick={onHide}>
          {t('fs_cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={!canSend}
          onClick={send}
          data-testid="factory-sensor-create-submit"
        >
          {saving && <Spinner size="sm" className="me-2" />}
          {mode === 'csv' && parsed.rows.length > 1
            ? t('fs_create_many', { count: parsed.rows.length })
            : t('fs_create')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

export default FactorySensorCreateModal;
