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
import { showRequestError } from '../components/ui/Snackbar.jsx';
import KpiStrip from '../components/ui/kit/KpiStrip';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import SearchableDataTable, {
  ROW_CLICK,
  type SearchableColumn,
} from '../components/ui/kit/SearchableDataTable';
import { formatDate } from './dateFormat';
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
};

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

/** Where a check is fixed. */
const fixPath = (key: string, id: number): string | null => {
  const wizard = `/lageplan/wizard/?location=${id}`;
  switch (key) {
    case 'address':
    case 'geo':
    case 'airtable':
      return `/location/${id}/objekt`;
    case 'threshold':
    case 'rain_check':
    case 'objektleitung':
      return `/location/${id}/einstellungen`;
    case 'users':
      return `/location/${id}/rechte`;
    case 'alarm_recipient':
      return `/location/${id}/benachrichtigungen`;
    case 'notifications_enabled':
      return '/device/statistics/';
    case 'heat_limitation':
      return `/location/${id}/heatmap2d`;
    case 'devices':
    case 'devices_online':
      return `/device/overview?location=${id}`;
    case 'lageplan':
    case 'lageplan_aligned':
    case 'lageplan_calibrated':
    case 'lageplan_cropped':
    case 'lageplan_resolution':
    case 'measure_points':
    case 'sensor_devices':
    case 'points_named':
    case 'dead_sensors_disabled':
      return wizard;
    default:
      return null;
  }
};

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
  if (check.key === 'devices_online' && !values.total) {
    return t('readiness_detail_needs_devices');
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
        const data = response?.data as Readiness;
        setReadiness(data);
        setLoading(false);
        // Checked now: every table and the picker show the new score.
        setLocationFlags(id, { readiness_score: data.score });
        setLocations((rows) =>
          rows.map((row) =>
            row.id === id ? { ...row, readiness_score: data.score } : row,
          ),
        );
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
                            {path && (
                              <Link
                                to={path}
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
    </div>
  );
};

export default LocationChecklistView;
