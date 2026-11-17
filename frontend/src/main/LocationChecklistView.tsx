import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useSnackbar } from 'notistack';
import { Badge, ProgressBar, Spinner } from 'react-bootstrap';
import {
  ArrowClockwise,
  CheckCircleFill,
  DashCircle,
  ExclamationCircleFill,
  XCircleFill,
} from 'react-bootstrap-icons';
import type { TFunction } from 'i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import LocationPicker, {
  type PickableLocation,
} from '../components/location/LocationPicker';
import {
  LOCATION_OFF_CLASS,
  ReadinessBadge,
  readinessLevel,
  setLocationFlags,
} from '../components/location/locationFlags';
import { showErrorBar, showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import KpiStrip from '../components/ui/kit/KpiStrip';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import SearchableDataTable, {
  ROW_CLICK,
  type SearchableColumn,
} from '../components/ui/kit/SearchableDataTable';
import { formatDate } from './dateFormat';
import { wizardPath } from './lageplanWizardAnchors';
import { repeatedTestId } from '../testIds';
import './LocationChecklistView.css';

/**
 * "Is the location ready?" (staff): the checklist of one location
 * (?location=<id>) - every check of the backend's location_readiness with
 * what is missing and a link to where it is fixed - and, without a
 * location, every location's stored score, lowest first.
 */

type CheckStatus = 'pass' | 'fail' | 'na';

export type ReadinessCheck = {
  key: string;
  group: string;
  weight: number;
  optional: boolean;
  status: CheckStatus;
  values: Record<string, string | number | null>;
};

type Readiness = {
  location: {
    id: number;
    project_id: number | null;
    name: string | null;
    purgeable: boolean | null;
  };
  score: number;
  level: string;
  checks: ReadinessCheck[];
  at: string;
  /** Fields the check filled from Airtable just now (missing address). */
  airtable_filled?: string[];
  /** "Beheben" of the Airtable check (readiness/airtable): what it took over. */
  airtable?: AirtableLink;
};

/** A field Airtable would change: the value now and Airtable's (the product with its name). */
export type AirtableChange = {
  field: string;
  old: { value: string | number | null; label: string | number | null };
  new: { value: string | number | null; label: string | number | null };
};

type AirtableLink = {
  status: 'preview' | 'updated' | 'unchanged' | 'not_found';
  changes: AirtableChange[];
  fields: string[];
  /** Confirmed changes not saved: Airtable has another value by now. */
  skipped?: string[];
  project_id: number | null;
};

/** The confirmed changes as the backend takes them: {field: Airtable's value}. */
export const acceptedChanges = (changes: AirtableChange[], denied: Set<string>) =>
  Object.fromEntries(
    changes.filter((change) => !denied.has(change.field)).map((change) => [change.field, change.new.value]),
  );

type OverviewRow = {
  id: number;
  project_id: number | null;
  name: string | null;
  city: string | null;
  purgeable: boolean | null;
  score: number | null;
  level: string | null;
  at: string | null;
  failed: string[];
};

const GROUPS = ['base', 'plan', 'devices', 'points', 'alarming'];
const LEVELS = ['ready', 'almost', 'progress', 'open'] as const;

/**
 * Where a check is fixed - the wizard at the step that does it. The
 * Airtable check is fixed in place ("Beheben" loads the project), see
 * AIRTABLE_FIX.
 */
export const fixPath = (key: string, id: number): string | null => {
  switch (key) {
    case 'product':
    case 'address':
    case 'geo':
      return `/location/${id}/objekt`;
    case 'threshold':
    case 'rain_check':
    case 'objektleitung':
      return `/location/${id}/einstellungen`;
    case 'users':
    case 'alarm_recipient':
      return `/location/${id}/rechte`;
    case 'notifications_enabled':
      return '/device/statistics/';
    case 'devices':
    case 'devices_online':
      return `/device/overview?location=${id}`;
    case 'sensor_devices':
      return wizardPath(id, 'devices');
    case 'lageplan':
    case 'lageplan_resolution':
      return wizardPath(id, 'plans');
    case 'measure_points':
    case 'points_named':
      return wizardPath(id, 'points');
    case 'lageplan_aligned':
    case 'lageplan_calibrated':
    case 'lageplan_cropped':
      return wizardPath(id, 'align');
    case 'heat_limitation':
      return wizardPath(id, 'heatLimits');
    default:
      return null;
  }
};

/** The check whose "Beheben" loads the location's Airtable project right here. */
const AIRTABLE_FIX = 'airtable';

/** What is missing - for a failed check. */
export const checkDetail = (t: TFunction, check: ReadinessCheck): string => {
  const values = check.values ?? {};
  if (values.error) {
    return t('readiness_detail_error', { error: values.error });
  }
  const needsPlan =
    ['lageplan_aligned', 'lageplan_calibrated'].includes(check.key) &&
    !values.total;
  if (needsPlan || (check.key === 'lageplan_cropped' && values.span == null)) {
    return t('readiness_detail_needs_plan');
  }
  if (check.key === 'lageplan_resolution') {
    // Low-res legacy plan (helper/plan_resolution.py): upload it again.
    return values.score == null
      ? t('readiness_detail_lageplan')
      : t('readiness_detail_lageplan_resolution', {
          score: values.score,
          grade: t(`readiness_resolution_${values.grade}`),
          long_side: values.long_side,
        });
  }
  if (check.key === 'sensor_devices') {
    const parts: string[] = [];
    if (Number(values.uncovered) > 0) {
      parts.push(
        t('readiness_detail_sensor_devices_uncovered', {
          count: Number(values.uncovered),
        }),
      );
    }
    if (Number(values.ambiguous) > 0) {
      parts.push(
        t('readiness_detail_sensor_devices_ambiguous', {
          count: Number(values.ambiguous),
        }),
      );
    }
    if (values.counted != null && values.counted !== values.points) {
      parts.push(
        t('readiness_detail_sensor_devices_count', {
          counted: values.counted,
          points: values.points,
        }),
      );
    }
    return parts.join('; ');
  }
  return t(`readiness_detail_${check.key}`, values);
};

/** How a check is shown: a failed optional check is a warning, not an error. */
type Severity = 'pass' | 'fail' | 'warn' | 'na';

const severityOf =(check: ReadinessCheck): Severity =>
  check.status === 'fail' && check.optional ? 'warn' : check.status;

/**
 * What each check is worth in the score (0-100): its weight among the checks
 * that apply (backend evaluate(): score = passed weights * 100 / total) -
 * "na" checks are left out and worth nothing.
 */
export const checkPoints = (checks: ReadinessCheck[]): Map<string, number> => {
  const total = checks
    .filter((check) => check.status !== 'na')
    .reduce((sum, check) => sum + check.weight, 0);
  return new Map(
    checks.map((check) => [
      check.key,
      check.status === 'na' || !total ? 0 : (check.weight * 100) / total,
    ]),
  );
};

const pointsFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});

const StatusIcon = ({ severity }: { severity: Severity }) =>
  severity === 'pass' ? (
    <CheckCircleFill
      className="checklist-icon checklist-icon--pass"
      aria-hidden
    />
  ) : severity === 'fail' ? (
    <XCircleFill className="checklist-icon checklist-icon--fail" aria-hidden />
  ) : severity === 'warn' ? (
    <ExclamationCircleFill
      className="checklist-icon checklist-icon--warn"
      aria-hidden
    />
  ) : (
    <DashCircle className="checklist-icon checklist-icon--na" aria-hidden />
  );

const LocationChecklistView = () => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const [searchParams, setSearchParams] = useSearchParams();
  const locationParam = Number(searchParams.get('location'));
  const locationId =
    Number.isInteger(locationParam) && locationParam > 0 ? locationParam : null;

  const [locations, setLocations] = useState<PickableLocation[]>([]);
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [overview, setOverview] = useState<OverviewRow[] | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [linkingAirtable, setLinkingAirtable] = useState(false);
  // The changes Airtable would make, to confirm - and the ones denied.
  const [airtablePreview, setAirtablePreview] = useState<{ id: number; changes: AirtableChange[] } | null>(null);
  const [deniedFields, setDeniedFields] = useState<Set<string>>(new Set());
  // Answers of an older selection are dropped.
  const requestRef = useRef(0);

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      '/v1/location/min/',
      (response) => {
        setLocations(Array.isArray(response?.data) ? response.data : []);
        setLocationsLoading(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('devices_locations_failed'), error);
        setLocationsLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadReadiness = (id: number) => {
    const request = ++requestRef.current;
    setLoading(true);
    return axiosConfig.perform_get(
      auth,
      `/v1/location/${id}/readiness/`,
      (response) => {
        if (request !== requestRef.current) {
          return;
        }
        // Checked now: every table and the picker show the new score.
        applyReadiness(id, response?.data as Readiness);
        setLoading(false);
      },
      (error) => {
        if (request !== requestRef.current) {
          return;
        }
        showRequestError(enqueueSnackbar, t('readiness_load_failed'), error);
        setLoading(false);
      },
    );
  };

  // Applies a fresh readiness answer (checked now) to the page.
  const applyReadiness = (id: number, data: Readiness) => {
    setReadiness(data);
    setLocationFlags(id, { readiness_score: data.score });
    setLocations((rows) => rows.map((row) => (row.id === id ? { ...row, readiness_score: data.score } : row)));
  };

  const fieldLabel = (field: string) => t(`readiness_airtable_field_${field}`, { defaultValue: field });

  // "Beheben" of the Airtable check, 1: the project by the location's
  // number and what it would change - nothing saved before it is confirmed.
  const previewAirtable = (id: number) => {
    setLinkingAirtable(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${id}/readiness/airtable/`,
      {},
      (response) => {
        setLinkingAirtable(false);
        const linked = response?.data?.airtable as AirtableLink | undefined;
        if (linked?.status === 'not_found') {
          showErrorBar(enqueueSnackbar, t('readiness_airtable_not_found', { project: linked.project_id ?? '–' }));
        } else if (linked?.status === 'preview' && linked.changes.length) {
          setDeniedFields(new Set());
          setAirtablePreview({ id, changes: linked.changes });
        } else {
          showSuccessBar(enqueueSnackbar, t('readiness_airtable_unchanged'));
        }
      },
      (error) => {
        setLinkingAirtable(false);
        showRequestError(enqueueSnackbar, t('readiness_airtable_failed'), error);
      },
    );
  };

  // 2: the confirmed changes saved - and the location checked again.
  const confirmAirtable = () => {
    if (!airtablePreview) {
      return;
    }
    const { id, changes } = airtablePreview;
    setLinkingAirtable(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${id}/readiness/airtable/`,
      { accept: acceptedChanges(changes, deniedFields) },
      (response) => {
        const data = response?.data as Readiness;
        setLinkingAirtable(false);
        setAirtablePreview(null);
        applyReadiness(id, data);
        const linked = data.airtable;
        if (linked?.fields.length) {
          showSuccessBar(
            enqueueSnackbar,
            t('readiness_airtable_updated', { fields: linked.fields.map(fieldLabel).join(', ') }),
          );
        }
        if (linked?.skipped?.length) {
          showErrorBar(
            enqueueSnackbar,
            t('readiness_airtable_skipped', { fields: linked.skipped.map(fieldLabel).join(', ') }),
          );
        }
      },
      (error) => {
        setLinkingAirtable(false);
        showRequestError(enqueueSnackbar, t('readiness_airtable_failed'), error);
      },
    );
  };

  const toggleDenied = (field: string) =>
    setDeniedFields((current) => {
      const next = new Set(current);
      if (next.has(field)) {
        next.delete(field);
      } else {
        next.add(field);
      }
      return next;
    });

  const loadOverview = () => {
    setOverviewLoading(true);
    return axiosConfig.perform_get(
      auth,
      '/v1/location/readiness/',
      (response) => {
        setOverview((response?.data?.locations ?? []) as OverviewRow[]);
        setOverviewLoading(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('readiness_load_failed'), error);
        setOverviewLoading(false);
      },
    );
  };

  useEffect(() => {
    setReadiness(null);
    if (locationId === null) {
      requestRef.current += 1;
      setLoading(false);
      void loadOverview();
      return;
    }
    void loadReadiness(locationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  const selectLocation = (location: PickableLocation | null) => {
    const next = new URLSearchParams(searchParams);
    if (location) {
      next.set('location', String(location.id));
    } else {
      next.delete('location');
    }
    setSearchParams(next, { replace: true });
  };

  const checkTitle = (key: string) => t(`readiness_check_${key}`);

  // -- overview ------------------------------------------------------------------

  const overviewColumns = useMemo<SearchableColumn<OverviewRow>[]>(
    () => [
      {
        name: t('readiness_column_score'),
        width: '90px',
        sortable: true,
        selector: (row) => row.score ?? -1,
        cell: (row) =>
          row.score == null ? (
            <span className="text-muted">–</span>
          ) : (
            <ReadinessBadge score={row.score} testKey={`overview-${row.id}`} />
          ),
        searchText: (row) =>
          row.level
            ? t(`readiness_level_${row.level}`)
            : t('readiness_never_checked'),
      },
      {
        name: t('readiness_column_location'),
        grow: 2,
        sortable: true,
        selector: (row) => row.name ?? '',
        cell: (row) => (
          <span {...ROW_CLICK}>
            {row.name || `#${row.id}`}
            {row.project_id != null && (
              <span className="text-muted ms-2">#{row.project_id}</span>
            )}
          </span>
        ),
        searchText: (row) =>
          `${row.name ?? ''} ${row.project_id ?? ''} ${row.city ?? ''}`,
      },
      {
        name: t('readiness_column_open'),
        grow: 3,
        cell: (row) => (
          <span className="checklist-open" {...ROW_CLICK}>
            {row.failed.slice(0, 4).map(checkTitle).join(' · ')}
            {row.failed.length > 4 && ` · +${row.failed.length - 4}`}
          </span>
        ),
        searchText: (row) => row.failed.map(checkTitle).join(' '),
      },
      {
        name: t('readiness_column_checked'),
        width: '150px',
        sortable: true,
        selector: (row) => row.at ?? '',
        cell: (row) => (
          <span {...ROW_CLICK}>{row.at ? formatDate(row.at) : '–'}</span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  const levelCounts = useMemo(() => {
    const counts: Record<string, number> = {
      ready: 0,
      almost: 0,
      progress: 0,
      open: 0,
      never: 0,
    };
    (overview ?? []).forEach((row) => {
      counts[row.score == null ? 'never' : readinessLevel(row.score)] += 1;
    });
    return counts;
  }, [overview]);

  const renderOverview = () => (
    <PanelCard
      title={t('readiness_overview_title')}
      testId="checklist-overview"
    >
      {overviewLoading && !overview ? (
        <div className="text-center py-3">
          <Spinner animation="border" size="sm" />
        </div>
      ) : (
        <>
          <KpiStrip
            testId="checklist-levels"
            tiles={[
              ...LEVELS.map((level) => ({
                label: t(`readiness_level_${level}`),
                value: String(levelCounts[level]),
                testId: `checklist-level-${level}`,
              })),
              {
                label: t('readiness_never_checked'),
                value: String(levelCounts.never),
                testId: 'checklist-level-never',
              },
            ]}
          />
          {levelCounts.never > 0 && (
            <div
              className="small text-muted mt-2"
              data-testid="checklist-never-hint"
            >
              {t('readiness_never_hint')}
            </div>
          )}
          <SearchableDataTable<OverviewRow>
            columns={overviewColumns}
            data={overview ?? []}
            dense
            pagination
            paginationPerPage={50}
            pointerOnHover
            highlightOnHover
            onRowClicked={(row) =>
              selectLocation({ id: row.id } as PickableLocation)
            }
            conditionalRowStyles={[
              {
                when: (row) => row.purgeable === true,
                classNames: [LOCATION_OFF_CLASS],
              },
            ]}
            testId="checklist-overview-table"
          />
        </>
      )}
    </PanelCard>
  );

  // -- one location ----------------------------------------------------------------

  const renderChecklist = (data: Readiness) => {
    const required = data.checks.filter((check) => !check.optional);
    const failed = required.filter((check) => check.status === 'fail');
    const warnings = data.checks.filter(
      (check) => severityOf(check) === 'warn',
    );
    const points = checkPoints(data.checks);
    const level = readinessLevel(data.score);
    return (
      <>
        <PanelCard testId="checklist-summary">
          <div className="checklist-summary">
            <div
              className={`checklist-score checklist-score--${level}`}
              data-testid="checklist-score"
            >
              {data.score}
              <span className="checklist-score-max">/100</span>
            </div>
            <div className="checklist-summary-text">
              <div className="fw-semibold" data-testid="checklist-level">
                {t(`readiness_level_${level}`)}
                {data.location.purgeable === true && (
                  <Badge bg="secondary" className="ms-2 fw-normal">
                    {t('location_flag_purgeable')}
                  </Badge>
                )}
              </div>
              <ProgressBar
                now={data.score}
                variant={
                  level === 'ready'
                    ? 'success'
                    : level === 'almost'
                      ? 'info'
                      : level === 'progress'
                        ? 'warning'
                        : 'danger'
                }
                className="checklist-progress"
              />
              <div
                className="small text-muted"
                data-testid="checklist-open-count"
              >
                {failed.length
                  ? t('readiness_open_count', {
                      count: failed.length,
                      total: required.length,
                    })
                  : warnings.length
                    ? t('readiness_required_passed')
                    : t('readiness_all_passed')}
                {warnings.length > 0 && (
                  <>
                    {' · '}
                    <span data-testid="checklist-warn-count">
                      {t('readiness_warn_count', { count: warnings.length })}
                    </span>
                  </>
                )}
                {' · '}
                {t('readiness_checked_at', { at: formatDate(data.at) })}
              </div>
              {Boolean(data.airtable_filled?.length) && (
                <div
                  className="small text-info-emphasis"
                  data-testid="checklist-airtable-filled"
                >
                  {t('readiness_airtable_filled', {
                    fields: data.airtable_filled!.join(', '),
                  })}
                </div>
              )}
              <div className="small text-muted">
                {t('readiness_points_explain')}
              </div>
            </div>
          </div>
        </PanelCard>
        {GROUPS.map((group) => {
          const checks = data.checks.filter((check) => check.group === group);
          if (!checks.length) {
            return null;
          }
          return (
            <PanelCard
              key={group}
              title={t(`readiness_group_${group}`)}
              testId={`checklist-group-${group}`}
            >
              <ul className="checklist-list">
                {checks.map((check) => {
                  const severity = severityOf(check);
                  const path =
                    check.status === 'fail'
                      ? fixPath(check.key, data.location.id)
                      : null;
                  const worth = pointsFormat.format(points.get(check.key) ?? 0);
                  return (
                    <li
                      key={check.key}
                      className={`checklist-item checklist-item--${severity}`}
                      {...repeatedTestId('checklist-check', check.key)}
                      data-status={check.status}
                      data-severity={severity}
                    >
                      <StatusIcon severity={severity} />
                      <div className="checklist-item-body">
                        <div>
                          <span className="checklist-item-title">
                            {checkTitle(check.key)}
                          </span>
                          {check.optional && (
                            <span className="checklist-optional">
                              {t('readiness_optional')}
                            </span>
                          )}
                          <span
                            className={`checklist-points checklist-points--${severity}`}
                            title={t(`readiness_points_${severity}`, {
                              points: worth,
                            })}
                            {...repeatedTestId('checklist-points', check.key)}
                          >
                            {check.status === 'na'
                              ? '–'
                              : t('readiness_points', {
                                  points:
                                    check.status === 'pass' ? `+${worth}` : worth,
                                })}
                          </span>
                        </div>
                        {check.status === 'fail' && (
                          <div
                            className="checklist-detail"
                            {...repeatedTestId('checklist-detail', check.key)}
                          >
                            {checkDetail(t, check)}
                            {check.key === AIRTABLE_FIX && (
                              <button
                                type="button"
                                className="btn btn-link btn-sm p-0 ms-2 align-baseline"
                                disabled={linkingAirtable}
                                title={t('readiness_airtable_fix_hint')}
                                onClick={() => previewAirtable(data.location.id)}
                                {...repeatedTestId('checklist-fix', check.key)}
                              >
                                {linkingAirtable ? t('ui_loading') : t('readiness_fix')}
                              </button>
                            )}
                            {path && (
                              <Link
                                to={path}
                                // The checklist stays open to check the next point.
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ms-2"
                                {...repeatedTestId('checklist-fix', check.key)}
                              >
                                {t('readiness_fix')}
                              </Link>
                            )}
                          </div>
                        )}
                        {check.status === 'na' && (
                          <div className="checklist-detail">
                            {t('readiness_na')}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </PanelCard>
          );
        })}
      </>
    );
  };

  return (
    <div className="location-checklist" data-testid="location-checklist">
      <PanelCard
        title={t('readiness_title')}
        testId="checklist-header"
        actions={
          <PillButton
            variant="ghost"
            icon={<ArrowClockwise size={14} />}
            label={t('readiness_recheck')}
            disabled={loading || overviewLoading}
            onClick={() =>
              void (locationId !== null
                ? loadReadiness(locationId)
                : loadOverview())
            }
            testId="checklist-recheck"
          />
        }
      >
        <div className="checklist-picker">
          <LocationPicker
            id="checklist-location"
            locations={locations}
            value={locationId}
            onChange={selectLocation}
            loading={locationsLoading}
            testId="checklist-location"
          />
        </div>
        <div className="small text-muted mt-2">{t('readiness_intro')}</div>
      </PanelCard>

      {locationId === null && renderOverview()}
      {locationId !== null && loading && !readiness && (
        <div className="text-center py-4" data-testid="checklist-loading">
          <Spinner animation="border" size="sm" />
        </div>
      )}
      {locationId !== null && readiness && renderChecklist(readiness)}

      <ConfirmDialog
        testId="checklist-airtable-confirm"
        show={airtablePreview !== null}
        title={t('readiness_airtable_confirm_title')}
        message={
          <div className="checklist-airtable-changes">
            <div className="small text-muted mb-2">{t('readiness_airtable_confirm_intro')}</div>
            {(airtablePreview?.changes ?? []).map((change) => (
              <label
                key={change.field}
                className="checklist-airtable-change"
                {...repeatedTestId('checklist-airtable-change', change.field)}
              >
                <input
                  type="checkbox"
                  className="form-check-input"
                  checked={!deniedFields.has(change.field)}
                  onChange={() => toggleDenied(change.field)}
                />
                <span className="checklist-airtable-field">{fieldLabel(change.field)}</span>
                <span className="checklist-airtable-old">{change.old.label ?? '–'}</span>
                <span aria-hidden="true">→</span>
                <span className="checklist-airtable-new">{change.new.label ?? '–'}</span>
              </label>
            ))}
          </div>
        }
        confirmLabel={t('readiness_airtable_confirm', {
          count: (airtablePreview?.changes.length ?? 0) - deniedFields.size,
        })}
        cancelLabel={t('readiness_airtable_cancel')}
        danger={false}
        confirming={linkingAirtable}
        confirmDisabled={(airtablePreview?.changes.length ?? 0) - deniedFields.size <= 0}
        onCancel={() => setAirtablePreview(null)}
        onConfirm={confirmAirtable}
      />
    </div>
  );
};

export default LocationChecklistView;
