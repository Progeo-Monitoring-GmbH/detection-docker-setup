import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Form, Modal, Spinner } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import SearchableDataTable, {
  type SearchableColumn,
} from '../../components/ui/kit/SearchableDataTable';
import SegmentedControl from '../../components/ui/kit/SegmentedControl';
import { repeatedTestId } from '../../testIds';
import {
  AIRTABLE_PROJECTS_URL,
  airtableImportUrl,
  formatOhm,
  IMPORT_ACTIONS,
  importable,
  type DmImportPreview,
  type DmImportResult,
  type DmImportRow,
  type DmProject,
  type ImportAction,
} from './factorySensors';
import './FactorySensorsView.css';

const ALL = 'all';

type Failure = {
  response?: { data?: { meldung?: string } };
  message?: string;
};

const message = (failure: Failure, fallback: string) =>
  failure?.response?.data?.meldung || failure?.message || fallback;

type Props = {
  /** The project to start with (the page's filter), else none. */
  projekt?: string;
  onHide: () => void;
  onImported: () => void;
};

/**
 * Creates dm sensors from the Airtable table "dm Sensoren", one project at a
 * time: pick the project (its production orders in Airtable), see what the
 * import does with each row (new / link / present / skipped and why), then
 * import. Airtable has no R_Werk - the sensors get it from the factory app.
 */
const FactorySensorAirtableImportModal = ({
  projekt: initialProject,
  onHide,
  onImported,
}: Props) => {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [projects, setProjects] = useState<DmProject[] | null>(null);
  const [project, setProject] = useState(initialProject ?? '');
  // The newest answer - shown only while it is the chosen project's.
  const [loaded, setLoaded] = useState<DmImportPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ImportAction | typeof ALL>(ALL);
  const locale = i18n.language;
  const preview = loaded && loaded.projekt === project ? loaded : null;
  const loading = !!project && !preview && !error;

  const choose = (value: string) => {
    setProject(value);
    setFilter(ALL);
    setError(null);
  };

  useEffect(() => {
    axiosConfig.perform_get(
      auth,
      AIRTABLE_PROJECTS_URL,
      (response: { data: { projekte: DmProject[] } }) =>
        setProjects(response.data.projekte),
      (failure: Failure) => {
        setProjects([]);
        setError(message(failure, t('fs_import_load_failed')));
      },
    );
  }, [auth, t]);

  useEffect(() => {
    if (!project) {
      return;
    }
    let current = true;
    axiosConfig.perform_get(
      auth,
      airtableImportUrl(project),
      (response: { data: DmImportPreview }) => {
        if (current) {
          setLoaded(response.data);
        }
      },
      (failure: Failure) => {
        if (current) {
          setError(message(failure, t('fs_import_load_failed')));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [auth, project, t]);

  const send = () => {
    setSaving(true);
    setError(null);
    axiosConfig.perform_post(
      auth,
      airtableImportUrl(project),
      {},
      (response: { data: DmImportResult }) => {
        setSaving(false);
        enqueueSnackbar(t('fs_import_done', response.data), {
          variant: 'success',
        });
        onImported();
      },
      (failure: Failure) => {
        setSaving(false);
        setError(message(failure, t('fs_save_failed')));
      },
    );
  };

  const options = useMemo(
    () =>
      (projects ?? []).map((item) => ({
        value: item.projekt,
        label: t('fs_import_project_option', {
          projekt: item.projekt,
          objekt: item.objekt ?? '–',
          airtable: item.sensoren_airtable,
          angelegt: item.sensoren_angelegt,
        }),
      })),
    [projects, t],
  );
  // The page's project may have no production orders in Airtable.
  const knownProject =
    !project || (projects ?? []).some((item) => item.projekt === project);

  const rows = useMemo(
    () =>
      (preview?.zeilen ?? []).filter(
        (row) => filter === ALL || row.aktion === filter,
      ),
    [preview, filter],
  );

  const columns = useMemo<SearchableColumn<DmImportRow>[]>(
    () => [
      {
        id: 'nr',
        name: t('fs_col_airtable_nr'),
        selector: (row) => row.nr,
        cell: (row) => <span className="fw-bold">{row.nr || '–'}</span>,
        searchText: (row) => row.nr,
        sortable: true,
      },
      {
        id: 'sensor',
        name: t('fs_col_sensor'),
        selector: (row) => row.sensor ?? '',
        format: (row) => row.sensor ?? '–',
        sortable: true,
      },
      {
        id: 'laenge',
        name: t('fs_col_laenge'),
        selector: (row) => row.laenge_m ?? 0,
        format: (row) =>
          row.laenge_m == null
            ? '–'
            : `${row.laenge_m.toLocaleString(locale)} m`,
        sortable: true,
        right: true,
      },
      {
        id: 'produktionsstatus',
        name: t('fs_col_produktionsstatus'),
        selector: (row) => row.produktionsstatus ?? '',
        format: (row) => row.produktionsstatus ?? '–',
        sortable: true,
      },
      {
        id: 'aktion',
        name: t('fs_col_aktion'),
        selector: (row) => row.aktion,
        cell: (row) => (
          <span
            className={`progeo-badge fs-import fs-import--${row.aktion}`}
            {...repeatedTestId('factory-sensor-import-action', row.airtable_id)}
          >
            {t(`fs_import_action_${row.aktion}`)}
          </span>
        ),
        searchText: (row) => t(`fs_import_action_${row.aktion}`),
        sortable: true,
      },
      {
        id: 'hinweis',
        name: t('fs_col_hinweis'),
        grow: 2,
        selector: (row) => row.grund ?? '',
        cell: (row) => (
          <span className="fs-import-hint">
            {row.grund
              ? t(`fs_import_reason_${row.grund}`, {
                  konflikt: row.konflikt.join(', '),
                })
              : row.aktion !== 'neu'
                ? t('fs_import_r_werk', {
                    r_werk:
                      row.r_werk_ohm == null
                        ? t('fs_r_werk_missing')
                        : formatOhm(row.r_werk_ohm, locale),
                  })
                : ''}
          </span>
        ),
        searchText: (row) =>
          row.grund ? t(`fs_import_reason_${row.grund}`) : '',
      },
    ],
    [locale, t],
  );

  const counts = preview?.kennzahlen;
  const total = importable(preview);

  return (
    <Modal
      show
      onHide={onHide}
      dialogClassName="fs-modal"
      data-testid="factory-sensor-import"
    >
      <Modal.Header closeButton>
        <Modal.Title>{t('fs_import_title')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="staff-insights-subtitle mb-3">
          {t('fs_import_hint')}
        </div>
        <Form.Group controlId="fs-import-project" className="fs-field mb-3">
          <Form.Label>{t('fs_col_projekt')}</Form.Label>
          {projects === null ? (
            <div>
              <Spinner size="sm" />
            </div>
          ) : (
            <Form.Select
              value={project}
              onChange={(event) => choose(event.target.value)}
              data-testid="factory-sensor-import-project"
            >
              <option value="">{t('fs_import_pick_project')}</option>
              {!knownProject && (
                <option value={project}>
                  {t('fs_import_project_unknown', { projekt: project })}
                </option>
              )}
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Form.Select>
          )}
        </Form.Group>
        {loading && (
          <div className="fs-import-loading">
            <Spinner size="sm" className="me-2" />
            {t('fs_import_loading')}
          </div>
        )}
        {counts && (
          <div data-testid="factory-sensor-import-preview">
            <div
              className="fs-preview-summary"
              data-testid="factory-sensor-import-summary"
            >
              {t('fs_import_summary', counts)}
            </div>
            <SearchableDataTable
              columns={columns}
              data={rows}
              testId="factory-sensor-import-table"
              labels={{
                placeholder: t('fs_search'),
                count: (shown: number, all: number) =>
                  t('fs_search_count', { shown, total: all }),
                noMatches: t('fs_no_matches'),
              }}
              toolbar={
                <SegmentedControl
                  options={[ALL, ...IMPORT_ACTIONS].map((value) => ({
                    value,
                    label:
                      value === ALL
                        ? t('fs_status_all')
                        : `${t(`fs_import_action_${value}`)} (${counts[value as ImportAction]})`,
                  }))}
                  value={filter}
                  onChange={(value) =>
                    setFilter(value as ImportAction | typeof ALL)
                  }
                  testId="factory-sensor-import-filter"
                />
              }
              dense
              pagination
              paginationPerPage={25}
              mobileColumns={['nr', 'aktion', 'hinweis']}
              noDataComponent={
                <div className="progeo-table-empty">{t('fs_import_empty')}</div>
              }
            />
          </div>
        )}
        {error && (
          <Alert
            variant="danger"
            className="mt-3 mb-0"
            data-testid="factory-sensor-import-error"
          >
            {error}
          </Alert>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline-secondary" onClick={onHide}>
          {t('fs_cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={saving || loading || total === 0}
          onClick={send}
          data-testid="factory-sensor-import-submit"
        >
          {saving && <Spinner size="sm" className="me-2" />}
          {counts && counts.neu > 0
            ? t('fs_import_submit_new', { count: counts.neu })
            : t('fs_import_submit')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

export default FactorySensorAirtableImportModal;
