import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { BoxArrowUpRight, ClockHistory, PlusLg } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { showRequestError } from '../../components/ui/Snackbar.jsx';
import KpiStrip from '../../components/ui/kit/KpiStrip';
import PanelCard from '../../components/ui/kit/PanelCard';
import PillButton from '../../components/ui/kit/PillButton';
import PillSelect from '../../components/ui/kit/PillSelect';
import SearchableDataTable, {
  ROW_CLICK,
  type SearchableColumn,
} from '../../components/ui/kit/SearchableDataTable';
import SegmentedControl from '../../components/ui/kit/SegmentedControl';
import { byNumberNullsLast } from '../../components/ui/kit/sortNullsLast';
import { formatDate } from '../dateFormat';
import { repeatedTestId } from '../../testIds';
import {
  adminUrl,
  formatDelta,
  formatOhm,
  SENSOR_STATUSES,
  SENSORS_URL,
  sensorStatus,
  type FactorySensorRow,
  type SensorsOverview,
  type SensorStatus,
  type UnmatchedMeasurement,
} from './factorySensors';
import FactorySensorCreateModal from './FactorySensorCreateModal';
import FactorySensorHistoryModal from './FactorySensorHistoryModal';
import { StatusBadge } from './FactorySensorStatus';
import './StaffInsights.css';
import './FactorySensorsView.css';

const ALL = 'all';
type Prefill = { projekt?: string; sensor?: string };

const KPI_COLORS: Partial<Record<SensorStatus | 'ohne_werkswert', string>> = {
  ok: 'var(--fs-ok)',
  pruefen: 'var(--fs-check)',
  defekt: 'var(--fs-defect)',
  unbekannt: 'var(--fs-unclear)',
};

/**
 * /staff/sensors/ - the dm sensors' factory values (R_Werk) and what the
 * manuSensor app measured on site: create them (one or a pasted CSV), see
 * each sensor's newest measurement and its history, and the measurements
 * that found no factory values. Staff only (as the endpoints).
 */
const FactorySensorsView = () => {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [project, setProject] = useState(ALL);
  const [status, setStatus] = useState<SensorStatus | typeof ALL>(ALL);
  const [data, setData] = useState<SensorsOverview | null>(null);
  const [creating, setCreating] = useState<Prefill | null>(null);
  const [history, setHistory] = useState<FactorySensorRow | null>(null);
  const locale = i18n.language;

  const load = useCallback(() => {
    const url =
      project === ALL
        ? SENSORS_URL
        : `${SENSORS_URL}?projekt=${encodeURIComponent(project)}`;
    axiosConfig.perform_get(
      auth,
      url,
      (response: { data: SensorsOverview }) => setData(response.data),
      (error: unknown) =>
        showRequestError(enqueueSnackbar, t('fs_load_failed'), error),
    );
  }, [auth, enqueueSnackbar, project, t]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(
    () =>
      (data?.sensoren ?? []).filter(
        (row) => status === ALL || sensorStatus(row) === status,
      ),
    [data, status],
  );

  const columns = useMemo<SearchableColumn<FactorySensorRow>[]>(
    () => [
      {
        id: 'projekt',
        name: t('fs_col_projekt'),
        selector: (row) => Number(row.projekt),
        format: (row) => row.projekt,
        sortable: true,
        width: '96px',
      },
      {
        id: 'sensor',
        name: t('fs_col_sensor'),
        selector: (row) => row.sensor,
        cell: (row) => (
          <span className="fw-bold" {...ROW_CLICK}>
            {row.sensor}
          </span>
        ),
        searchText: (row) => row.sensor,
        sortable: true,
        width: '96px',
      },
      {
        id: 'band',
        name: t('fs_col_band'),
        selector: (row) => row.band ?? '',
        format: (row) => row.band ?? '–',
        sortable: true,
      },
      {
        id: 'tag_uid',
        name: t('fs_col_tag_uid'),
        selector: (row) => row.tag_uid ?? '',
        format: (row) => row.tag_uid ?? '–',
        sortable: true,
        grow: 1.5,
      },
      {
        id: 'r_werk_ohm',
        name: t('fs_col_r_werk_ohm'),
        selector: (row) => row.r_werk_ohm,
        format: (row) => formatOhm(row.r_werk_ohm, locale),
        sortable: true,
        right: true,
      },
      {
        id: 'zeit',
        name: t('fs_col_last'),
        selector: (row) => row.letzte_messung?.zeit ?? '',
        format: (row) =>
          row.letzte_messung ? formatDate(row.letzte_messung.zeit) : '–',
        sortable: true,
        grow: 1.4,
      },
      {
        id: 'delta',
        name: t('fs_col_delta'),
        selector: (row) => row.letzte_messung?.delta_prozent ?? 0,
        cell: (row) => (
          <span className="fw-bold" {...ROW_CLICK}>
            {formatDelta(row.letzte_messung?.delta_prozent, locale)}
          </span>
        ),
        searchText: (row) =>
          formatDelta(row.letzte_messung?.delta_prozent, locale),
        sortable: true,
        sortFunction: byNumberNullsLast(
          (row: FactorySensorRow) => row.letzte_messung?.delta_prozent ?? null,
        ),
        right: true,
      },
      {
        id: 'status',
        name: t('fs_col_status'),
        selector: (row) => sensorStatus(row),
        cell: (row) => (
          <StatusBadge
            status={sensorStatus(row)}
            testId="factory-sensors-status-badge"
            testKey={row.id}
          />
        ),
        searchText: (row) => t(`fs_status_${sensorStatus(row)}`),
        sortable: true,
      },
      {
        id: 'messungen',
        name: t('fs_col_count'),
        selector: (row) => row.messungen,
        sortable: true,
        right: true,
        width: '96px',
      },
      {
        id: 'actions',
        name: '',
        width: '96px',
        ignoreRowClick: true,
        cell: (row) => (
          <span className="fs-row-actions">
            <button
              type="button"
              className="progeo-icon-button"
              title={t('fs_history')}
              aria-label={t('fs_history')}
              onClick={() => setHistory(row)}
              {...repeatedTestId('factory-sensors-history', row.id)}
            >
              <ClockHistory size={14} />
            </button>
            <a
              className="progeo-icon-button"
              href={adminUrl(row.id)}
              target="_blank"
              rel="noreferrer"
              title={t('fs_admin_edit')}
              aria-label={t('fs_admin_edit')}
            >
              <BoxArrowUpRight size={13} />
            </a>
          </span>
        ),
      },
    ],
    [locale, t],
  );

  const unmatchedColumns = useMemo<SearchableColumn<UnmatchedMeasurement>[]>(
    () => [
      {
        id: 'projekt',
        name: t('fs_col_projekt'),
        selector: (row) => Number(row.projekt),
        format: (row) => row.projekt,
        sortable: true,
        width: '96px',
      },
      {
        id: 'sensor',
        name: t('fs_col_sensor'),
        selector: (row) => row.sensor,
        cell: (row) => <span className="fw-bold">{row.sensor}</span>,
        searchText: (row) => row.sensor,
        sortable: true,
        width: '96px',
      },
      {
        id: 'zeit',
        name: t('fs_col_zeit'),
        selector: (row) => row.zeit,
        format: (row) => formatDate(row.zeit),
        sortable: true,
        grow: 1.4,
      },
      {
        id: 'r_ohm',
        name: t('fs_col_r_ohm'),
        selector: (row) => row.r_ohm ?? 0,
        format: (row) => formatOhm(row.r_ohm, locale),
        sortable: true,
        right: true,
      },
      {
        id: 'r_status',
        name: t('fs_col_r_status'),
        selector: (row) => t(`fs_r_status_${row.r_status}`),
        sortable: true,
      },
      {
        id: 'geraet',
        name: t('fs_col_geraet'),
        selector: (row) => row.geraet,
        sortable: true,
      },
      {
        id: 'benutzer',
        name: t('fs_col_benutzer'),
        selector: (row) => row.benutzer ?? '',
        format: (row) => row.benutzer ?? '–',
        sortable: true,
      },
      {
        id: 'action',
        name: '',
        grow: 1.4,
        ignoreRowClick: true,
        cell: (row) =>
          row.werkswert_vorhanden ? (
            <span className="fs-later" title={t('fs_unmatched_later_hint')}>
              {t('fs_unmatched_later')}
            </span>
          ) : (
            <PillButton
              label={t('fs_unmatched_create')}
              icon={<PlusLg size={12} />}
              variant="ghost"
              onClick={() =>
                setCreating({ projekt: row.projekt, sensor: row.sensor })
              }
              testId="factory-sensors-unmatched-create"
              testKey={String(row.id)}
            />
          ),
      },
    ],
    [locale, t],
  );

  const counts = data?.kennzahlen;
  const kpis = (
    ['sensoren', ...SENSOR_STATUSES, 'ohne_werkswert'] as const
  ).map((key) => ({
    label: t(`fs_kpi_${key}`),
    value: counts ? String(counts[key]) : '–',
    valueColor: counts && counts[key] > 0 ? KPI_COLORS[key] : undefined,
    testId: `factory-sensors-kpi-${key}`,
  }));
  const tableLabels = {
    placeholder: t('fs_search'),
    count: (shown: number, total: number) =>
      t('fs_search_count', { shown, total }),
    noMatches: t('fs_no_matches'),
  };

  return (
    <div className="staff-insights fs-page" data-testid="page-factory-sensors">
      <PanelCard
        title={t('fs_title')}
        testId="factory-sensors-header"
        actions={
          <div className="fs-header-actions">
            <PillSelect
              label={t('fs_col_projekt')}
              options={[
                { value: ALL, label: t('fs_all_projects') },
                ...(data?.projekte ?? []).map((value) => ({
                  value,
                  label: value,
                })),
              ]}
              value={project}
              onChange={setProject}
              testId="factory-sensors-project"
            />
            <PillButton
              label={t('fs_create_title')}
              icon={<PlusLg size={12} />}
              variant="accent"
              onClick={() =>
                setCreating({ projekt: project === ALL ? '' : project })
              }
              testId="factory-sensors-add"
            />
          </div>
        }
      >
        <div className="staff-insights-subtitle">
          {t('fs_subtitle', { tolerance: data?.toleranz_prozent ?? 5 })}
        </div>
      </PanelCard>
      <PanelCard
        bodyClassName="staff-insights-strip"
        testId="factory-sensors-kpis"
      >
        <KpiStrip tiles={kpis} />
      </PanelCard>
      <PanelCard title={t('fs_sensors')} testId="factory-sensors-panel">
        {data === null ? (
          <Spinner size="sm" />
        ) : (
          <SearchableDataTable
            columns={columns}
            data={rows}
            testId="factory-sensors-table"
            labels={tableLabels}
            toolbar={
              <SegmentedControl
                options={[ALL, ...SENSOR_STATUSES].map((value) => ({
                  value,
                  label:
                    value === ALL
                      ? t('fs_status_all')
                      : t(`fs_status_${value}`),
                }))}
                value={status}
                onChange={(value) =>
                  setStatus(value as SensorStatus | typeof ALL)
                }
                testId="factory-sensors-status"
              />
            }
            onRowClicked={(row) => setHistory(row)}
            pointerOnHover
            defaultSortFieldId="projekt"
            pagination
            paginationPerPage={50}
            mobileColumns={['sensor', 'status', 'actions']}
            columnWidthsKey="factory_sensors"
            noDataComponent={
              <div className="progeo-table-empty">{t('fs_empty')}</div>
            }
          />
        )}
      </PanelCard>
      {!!data?.ohne_werkswert.length && (
        <PanelCard
          title={t('fs_unmatched_title')}
          testId="factory-sensors-unmatched-panel"
        >
          <div className="staff-insights-subtitle mb-2">
            {t('fs_unmatched_hint')}
          </div>
          <SearchableDataTable
            columns={unmatchedColumns}
            data={data.ohne_werkswert}
            testId="factory-sensors-unmatched"
            labels={tableLabels}
            pagination
            paginationPerPage={25}
            mobileColumns={['sensor', 'zeit', 'action']}
          />
        </PanelCard>
      )}
      {creating && (
        <FactorySensorCreateModal
          prefill={creating}
          onHide={() => setCreating(null)}
          onCreated={() => {
            setCreating(null);
            load();
          }}
        />
      )}
      {history && (
        <FactorySensorHistoryModal
          sensor={history}
          onHide={() => setHistory(null)}
        />
      )}
    </div>
  );
};

export default FactorySensorsView;
