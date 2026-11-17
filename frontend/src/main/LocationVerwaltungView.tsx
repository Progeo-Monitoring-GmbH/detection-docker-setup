import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Spinner } from 'react-bootstrap';
import DataTable, { type TableColumn } from 'react-data-table-component';
import { ArrowCounterclockwise, Trash3 } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import KpiStrip from '../components/ui/kit/KpiStrip';
import SeverityBadge, { type Severity } from '../components/ui/kit/SeverityBadge';
import { matchesLocationSearch } from '../components/location/locationSearch';
import { repeatedTestId } from '../testIds';
import { progeoTableStyles } from '../components/ui/kit/SearchableDataTable';
import {
  ReadinessBadge,
  locationFlagRowStyles,
  seedLocationFlags,
  setLocationFlags,
  useLocationFlags,
} from '../components/location/locationFlags';
import {
  LOCATION_LIST_CLASS,
  LocationNameCell,
  TwoLineCell,
  locationAddressLine,
} from '../components/location/LocationListCells';
import { getProjectTypeLabel } from './projectType';
import { untaggedRowClick } from './wholeRowClick';
import './LocationVerwaltungView.css';

type VerwaltungRow = {
  /** verwaltungRowKey - DataTable's keyField. */
  key?: string;
  id: number;
  account_id: number;
  nr: number | null;
  name: string | null;
  city: string | null;
  owner: string | null;
  status: Severity | 'ok';
  // Same query as the rest (LocationViewSet.ADMIN_OVERVIEW_EXTRA_FIELDS).
  plz?: string | null;
  address?: string | null;
  project_type?: number | null;
  purgeable?: boolean | null;
  notifications_disabled?: boolean | null;
  readiness_score?: number | null;
};

/** Location ids are only unique within one account database. */
export const verwaltungRowKey = (row: Pick<VerwaltungRow, 'account_id' | 'id'>) => `${row.account_id}-${row.id}`;

type Kpis = { ok: number; beobachten: number; alarm: number; kritisch: number };

/** Rows per admin_overview request: the first chunk shows at once, the rest follows. */
export const VERWALTUNG_CHUNK_SIZE = 200;

/** The KPI tiles over the rows loaded so far. */
export const verwaltungKpis = (rows: ReadonlyArray<Pick<VerwaltungRow, 'status'>>): Kpis => {
  const kpis: Kpis = { ok: 0, beobachten: 0, alarm: 0, kritisch: 0 };
  rows.forEach((row) => {
    kpis[row.status] += 1;
  });
  return kpis;
};

/** Sort order of the status column: worst first when descending. */
const STATUS_RANK: Record<VerwaltungRow['status'], number> = { ok: 0, beobachten: 1, alarm: 2, kritisch: 3 };

type AccessRule = {
  id: number;
  user?: number | null;
  user_name?: string | null;
  user_email?: string | null;
  is_staff?: boolean;
  transport?: number | null;
};

type AccessUser = {
  id: number;
  username: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
};

/** Answer of POST access/invite (backend helper/location_invites.py). */
type InviteStatus = 'granted' | 'invited' | 'already' | 'staff';

const INVITE_MESSAGE_KEYS: Record<InviteStatus, string> = {
  granted: 'rechte_invite_granted',
  invited: 'rechte_invite_invited',
  already: 'rechte_invite_already',
  staff: 'rechte_invite_staff',
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "First Last (mail)" - the username when the name is empty. */
export const accessUserLabel = (user: AccessUser): string => {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.username;
  return user.email && user.email !== name ? `${name} (${user.email})` : name;
};

/** The picker's users without access yet, narrowed by `filter` (name, username, mail). */
export const pickableUsers = (
  users: AccessUser[],
  rules: Array<{ user?: number | null }>,
  filter: string,
) => {
  const needle = filter.trim().toLowerCase();
  return users.filter(
    (user) =>
      !rules.some((rule) => rule.user === user.id) &&
      (!needle ||
        [user.username, user.first_name, user.last_name, user.email].some((value) =>
          (value || '').toLowerCase().includes(needle),
        )),
  );
};

const STATUS_FILTERS: Array<{ value: string; labelKey: string }> = [
  { value: 'Alle', labelKey: 'verwaltung_filter_all' },
  { value: 'kritisch', labelKey: 'ui_severity_kritisch' },
  { value: 'alarm', labelKey: 'ui_severity_alarm' },
  { value: 'beobachten', labelKey: 'ui_severity_beobachten' },
  { value: 'ok', labelKey: 'verwaltung_filter_ok' },
];

/**
 * Verwaltung (Objektverwaltung): a cross-tenant admin dashboard - every
 * ProgeoLocation across every Account, not just the staff user's own bound
 * one. Backed by the new staff-only LocationViewSet.admin_overview action.
 */
const LocationVerwaltungView = () => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();

  const [rows, setRows] = useState<VerwaltungRow[]>([]);
  const [loading, setLoading] = useState(true);
  /** All locations (admin_overview "count") - known with the first chunk. */
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState<Record<string, boolean>>({});
  const [denied, setDenied] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('Alle');

  const [permsFor, setPermsFor] = useState<VerwaltungRow | null>(null);
  const [rules, setRules] = useState<AccessRule[]>([]);
  const [accessUsers, setAccessUsers] = useState<AccessUser[]>([]);
  const [permsLoading, setPermsLoading] = useState(false);
  const [newUserId, setNewUserId] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteFirstName, setInviteFirstName] = useState('');
  const [inviteLastName, setInviteLastName] = useState('');
  const [inviting, setInviting] = useState(false);

  // The chunks are requested one after the other - with the newest auth.
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  // In chunks: the first VERWALTUNG_CHUNK_SIZE rows show at once (each
  // chunk's alarm rollup covers only its own locations), the rest follows.
  useEffect(() => {
    let cancelled = false;
    const loadChunk = (offset: number) => {
      void axiosConfig.perform_get(
        authRef.current,
        `/v1/location/admin_overview/?offset=${offset}&limit=${VERWALTUNG_CHUNK_SIZE}`,
        (response) => {
          if (cancelled) {
            return;
          }
          const objects = ((response?.data?.objects || []) as VerwaltungRow[]).map((row) => ({
            ...row,
            key: verwaltungRowKey(row),
          }));
          // The flags came with the rows - no /v1/location/flags/ round trips.
          seedLocationFlags(objects.filter((row) => 'purgeable' in row));
          setRows((previous) => (offset === 0 ? objects : [...previous, ...objects]));
          setTotal(typeof response?.data?.count === 'number' ? response.data.count : null);
          setLoading(false);
          const next = response?.data?.next_offset;
          setLoadingMore(typeof next === 'number');
          if (typeof next === 'number') {
            loadChunk(next);
          }
        },
        (error) => {
          if (cancelled) {
            return;
          }
          if (error?.response?.status === 400 || error?.response?.status === 403) {
            setDenied(true);
          } else {
            showRequestError(enqueueSnackbar, 'Could not load objects', error);
          }
          setLoading(false);
          setLoadingMore(false);
        },
      );
    };
    loadChunk(0);
    return () => {
      cancelled = true;
    };
  }, [enqueueSnackbar]);

  // The list has every location of every account (~1000 rows): typing
  // updates the field at once, the rows follow when React has time.
  const deferredSearch = useDeferredValue(search);
  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (statusFilter !== 'Alle' && row.status !== statusFilter) {
        return false;
      }
      return matchesLocationSearch(
        { name: row.name, project_id: row.nr, city: row.city, plz: row.plz, address: row.address, owner: row.owner },
        deferredSearch,
      );
    });
  }, [rows, deferredSearch, statusFilter]);
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  // Switched-off locations striped grey, purgeable ones red.
  const { flagsOf } = useLocationFlags(rowIds);
  const navigate = useNavigate();
  const kpis = useMemo(() => verwaltungKpis(rows), [rows]);

  const kpiTiles = [
    { label: t('verwaltung_kpi_total'), value: String(total ?? rows.length) },
    { label: t('ui_severity_kritisch'), value: String(kpis.kritisch), valueColor: '#C44D26' },
    { label: t('ui_severity_alarm'), value: String(kpis.alarm), valueColor: '#EB633B' },
    { label: t('ui_severity_beobachten'), value: String(kpis.beobachten), valueColor: '#9A7208' },
  ];

  const openRow = useCallback((row: VerwaltungRow) => navigate(`/location/${row.id}/status`), [navigate]);

  /** Mark / unmark as purgeable (unmark = reviewed, kept: false) - like the /map/ list. */
  const togglePurgeable = useCallback(
    (row: VerwaltungRow) => {
      const key = verwaltungRowKey(row);
      const purgeable = flagsOf(row.id)?.purgeable !== true;
      setPurgeBusy((current) => ({ ...current, [key]: true }));
      void axiosConfig.perform_post(
        authRef.current,
        `/v1/location/${row.id}/purgeable/`,
        { purgeable },
        (response) => {
          const saved = (response?.data?.location?.purgeable ?? purgeable) as boolean | null;
          setLocationFlags(row.id, { purgeable: saved });
          setRows((current) =>
            current.map((candidate) =>
              verwaltungRowKey(candidate) === key ? { ...candidate, purgeable: saved } : candidate,
            ),
          );
          setPurgeBusy((current) => ({ ...current, [key]: false }));
          showSuccessBar(
            enqueueSnackbar,
            t(saved ? 'locmap_purgeable_marked_toast' : 'locmap_purgeable_unmarked_toast', {
              name: row.name || row.nr || row.id,
            }),
          );
        },
        (error) => {
          setPurgeBusy((current) => ({ ...current, [key]: false }));
          showRequestError(enqueueSnackbar, t('locmap_purgeable_error'), error);
        },
      );
    },
    [enqueueSnackbar, flagsOf, t],
  );

  const loadPerms = useCallback((row: VerwaltungRow) => {
    setPermsFor(row);
    setPermsLoading(true);
    setNewUserId('');
    setUserFilter('');
    setInviteEmail('');
    setInviteFirstName('');
    setInviteLastName('');
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${row.id}/access/`,
      (response) => {
        const allRules = (response?.data?.access || []) as AccessRule[];
        setRules(allRules.filter((rule) => !rule.is_staff));
        setAccessUsers((response?.data?.users || []) as AccessUser[]);
        setPermsLoading(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not load permissions', error);
        setPermsLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addUser = () => {
    if (!permsFor || !newUserId) {
      return;
    }
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${permsFor.id}/access/`,
      { user_id: Number(newUserId), transport: 1, type: 1 },
      (response) => {
        const saved = response?.data?.access as AccessRule | undefined;
        if (saved) {
          setRules((prev) => [...prev, saved]);
        }
        setNewUserId('');
        showSuccessBar(enqueueSnackbar, t('rechte_added'));
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not add user', error);
      },
    );
  };

  const removeRule = (rule: AccessRule) => {
    if (!permsFor) {
      return;
    }
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${permsFor.id}/access/delete/`,
      { id: rule.id },
      () => {
        setRules((prev) => prev.filter((r) => r.id !== rule.id));
        showSuccessBar(enqueueSnackbar, t('rechte_removed'));
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not remove access', error);
      },
    );
  };

  const inviteValid = EMAIL_PATTERN.test(inviteEmail.trim());

  /** A new address gets an invitation, a known one access plus a notice (access/invite). */
  const inviteUser = () => {
    if (!permsFor || !inviteValid) {
      return;
    }
    const row = permsFor;
    const email = inviteEmail.trim();
    setInviting(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${row.id}/access/invite/`,
      { email, scope: 'single', first_name: inviteFirstName.trim(), last_name: inviteLastName.trim() },
      (response) => {
        const status = response?.data?.status as InviteStatus | undefined;
        showSuccessBar(enqueueSnackbar, t((status && INVITE_MESSAGE_KEYS[status]) || 'rechte_added', { email }));
        setInviting(false);
        // Reload: the new rule (and a newly created user for the picker).
        loadPerms(row);
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not send the invitation', error);
        setInviting(false);
      },
    );
  };

  const availableUsers = useMemo(
    () => pickableUsers(accessUsers, rules, userFilter),
    [accessUsers, rules, userFilter],
  );

  const columns = useMemo<TableColumn<VerwaltungRow>[]>(
    () => [
      {
        id: 'nr',
        name: t('verwaltung_col_nr'),
        selector: (row) => row.nr ?? -1,
        sortable: true,
        width: '80px',
        cell: (row) => <span className="location-list-num">{row.nr ?? '–'}</span>,
      },
      {
        id: 'object',
        name: t('verwaltung_col_object'),
        selector: (row) => (row.name || '').toLowerCase(),
        sortable: true,
        grow: 3,
        cell: (row) => {
          const key = verwaltungRowKey(row);
          const flags = flagsOf(row.id);
          return (
            <LocationNameCell
              locationId={row.id}
              name={
                <Link
                  to={`/location/${row.id}/status`}
                  title={t('verwaltung_open')}
                  {...repeatedTestId('verwaltung-row-open', key)}
                >
                  {row.name || '–'}
                </Link>
              }
              subline={locationAddressLine(row)}
              // The score has its own column here.
              flags={flags ? { ...flags, readiness_score: null } : null}
              testKey={`verwaltung-${key}`}
            />
          );
        },
      },
      {
        id: 'product',
        name: t('verwaltung_col_product'),
        selector: (row) => (row.project_type ? getProjectTypeLabel(t, row.project_type) : ''),
        sortable: true,
        cell: (row) =>
          row.project_type ? (
            <span className="location-list-product">{getProjectTypeLabel(t, row.project_type)}</span>
          ) : (
            <span className="location-list-muted">–</span>
          ),
      },
      {
        id: 'owner',
        name: t('verwaltung_col_owner'),
        selector: (row) => (row.owner || '').toLowerCase(),
        sortable: true,
        cell: (row) => <TwoLineCell plain primary={row.owner || '–'} title={row.owner || undefined} />,
      },
      {
        id: 'status',
        name: t('verwaltung_col_status'),
        selector: (row) => STATUS_RANK[row.status],
        sortable: true,
        width: '120px',
        cell: (row) => (
          <span {...repeatedTestId('verwaltung-row-status', verwaltungRowKey(row))}>
            {row.status === 'ok' ? (
              <span className="location-verwaltung-ok">{t('status_kpi_ok')}</span>
            ) : (
              <SeverityBadge severity={row.status} label={t(`ui_severity_${row.status}`)} />
            )}
          </span>
        ),
      },
      {
        id: 'score',
        name: t('verwaltung_col_score'),
        selector: (row) => flagsOf(row.id)?.readiness_score ?? row.readiness_score ?? -1,
        sortable: true,
        width: '90px',
        cell: (row) => {
          const score = flagsOf(row.id)?.readiness_score ?? row.readiness_score;
          return score == null ? (
            <span className="location-list-muted" title={t('verwaltung_score_none')}>
              –
            </span>
          ) : (
            <ReadinessBadge score={score} locationId={row.id} testKey={`verwaltung-${verwaltungRowKey(row)}`} />
          );
        },
      },
      {
        id: 'purgeable',
        name: t('verwaltung_col_purgeable'),
        selector: (row) => (flagsOf(row.id)?.purgeable === true ? 1 : 0),
        sortable: true,
        width: '190px',
        cell: (row) => {
          const key = verwaltungRowKey(row);
          const purgeable = flagsOf(row.id)?.purgeable === true;
          return (
            <button
              type="button"
              className={`location-verwaltung-purge${purgeable ? ' location-verwaltung-purge--on' : ''}`}
              onClick={() => togglePurgeable(row)}
              disabled={Boolean(purgeBusy[key])}
              title={t(purgeable ? 'locmap_purgeable_unmark_title' : 'locmap_purgeable_mark_title')}
              {...repeatedTestId('verwaltung-row-purgeable', key)}
            >
              {purgeable ? <ArrowCounterclockwise size={12} /> : <Trash3 size={12} />}
              {t(purgeable ? 'locmap_purgeable_unmark' : 'locmap_purgeable_mark')}
            </button>
          );
        },
      },
      {
        id: 'actions',
        name: t('verwaltung_col_actions'),
        right: true,
        width: '150px',
        cell: (row) => (
          <span className="location-list-actions">
            <PillButton
              label={t('verwaltung_permissions')}
              onClick={() => loadPerms(row)}
              testId="verwaltung-row-permissions"
              testKey={verwaltungRowKey(row)}
            />
          </span>
        ),
      },
    ],
    [flagsOf, loadPerms, purgeBusy, t, togglePurgeable],
  );
  const rowStyles = useMemo(() => locationFlagRowStyles((row: VerwaltungRow) => flagsOf(row.id)), [flagsOf]);
  const paginationOptions = {
    rowsPerPageText: t('locations_rows_per_page'),
    rangeSeparatorText: t('locations_range_separator'),
  };

  if (denied) {
    return (
      <PanelCard title={t('verwaltung_title')} testId="page-verwaltung">
        <div className="location-verwaltung-muted" data-testid="verwaltung-denied">{t('verwaltung_denied')}</div>
      </PanelCard>
    );
  }

  return (
    <div className="location-verwaltung" data-testid="page-verwaltung">
      {loading ? (
        <div className="d-flex justify-content-center py-5 text-muted" data-testid="verwaltung-loading">
          <Spinner animation="border" />
        </div>
      ) : (
        <>
          <KpiStrip tiles={kpiTiles} testId="verwaltung-kpis" />

          <PanelCard
            testId="verwaltung-objects"
            title={
              <span className="location-verwaltung-title">
                {t('verwaltung_objects_title')}
                <span className="location-verwaltung-count" data-testid="verwaltung-count">
                  {t('verwaltung_object_count', { count: filtered.length, total: rows.length })}
                </span>
                {loadingMore && (
                  <span className="location-verwaltung-loading-more" data-testid="verwaltung-loading-more">
                    <Spinner animation="border" size="sm" />
                    {t('verwaltung_loading_more', { loaded: rows.length, total: total ?? rows.length })}
                  </span>
                )}
              </span>
            }
            actions={
              <div className="location-verwaltung-actions" data-testid="verwaltung-filters">
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('verwaltung_search_placeholder')}
                  className="location-verwaltung-search"
                  data-testid="verwaltung-search"
                />
                <div className="progeo-pill-track" data-testid="verwaltung-status-filter">
                  {STATUS_FILTERS.map((filter) => (
                    <PillButton
                      key={filter.value}
                      label={t(filter.labelKey)}
                      active={statusFilter === filter.value}
                      onClick={() => setStatusFilter(filter.value)}
                      testId="verwaltung-status-filter-option"
                      testKey={filter.value}
                    />
                  ))}
                </div>
              </div>
            }
          >
            {filtered.length === 0 ? (
              <div className="location-verwaltung-muted location-verwaltung-empty" data-testid="verwaltung-empty">
                {t('verwaltung_no_objects')}
              </div>
            ) : (
              // Rows keep DataTable's own keyboard handling (Enter on a focused row);
              // clicks on untagged cell content open the object too.
              <div
                className={LOCATION_LIST_CLASS}
                onClick={untaggedRowClick(filtered, openRow, verwaltungRowKey)}
                data-testid="verwaltung-table"
              >
                <DataTable
                  columns={columns}
                  data={filtered}
                  keyField="key"
                  customStyles={progeoTableStyles}
                  conditionalRowStyles={rowStyles}
                  pagination
                  paginationPerPage={50}
                  paginationRowsPerPageOptions={[25, 50, 100, 250]}
                  paginationComponentOptions={paginationOptions}
                  defaultSortFieldId="nr"
                  highlightOnHover
                  pointerOnHover
                  onRowClicked={openRow}
                  dense
                />
              </div>
            )}
          </PanelCard>
        </>
      )}

      {permsFor && (
        <div
          onClick={() => setPermsFor(null)}
          className="location-verwaltung-backdrop"
          data-testid="verwaltung-permissions-backdrop"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="location-verwaltung-dialog"
            data-testid="verwaltung-permissions-dialog"
          >
            <div className="location-verwaltung-dialog-head">
              <div className="location-verwaltung-dialog-heading">
                <div className="location-verwaltung-eyebrow">
                  {t('verwaltung_permissions')} · {permsFor.nr ?? permsFor.id}
                </div>
                <div className="location-verwaltung-dialog-title">{permsFor.name}</div>
              </div>
              <div className="location-verwaltung-spacer" />
              <button
                type="button"
                onClick={() => setPermsFor(null)}
                aria-label={t('verwaltung_close')}
                className="location-verwaltung-close"
                data-testid="verwaltung-permissions-close"
              >
                ×
              </button>
            </div>

            {permsLoading ? (
              <div className="d-flex justify-content-center py-4 text-muted" data-testid="verwaltung-permissions-loading">
                <Spinner animation="border" size="sm" />
              </div>
            ) : (
              <>
                {rules.length === 0 && (
                  <div className="location-verwaltung-rules-empty" data-testid="verwaltung-permissions-empty">
                    {t('rechte_empty')}
                  </div>
                )}
                {rules.map((rule) => (
                  <div
                    key={rule.id}
                    className="location-verwaltung-rule"
                    {...repeatedTestId('verwaltung-permissions-rule', rule.id)}
                  >
                    <div className="location-verwaltung-rule-user">
                      <div className="location-verwaltung-rule-name">{rule.user_name || `#${rule.user}`}</div>
                      <div className="location-verwaltung-rule-email">{rule.user_email || '–'}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeRule(rule)}
                      className="location-verwaltung-revoke"
                      {...repeatedTestId('verwaltung-permissions-revoke', rule.id)}
                    >
                      {t('rechte_revoke')}
                    </button>
                  </div>
                ))}

                <div className="location-verwaltung-section-title">{t('verwaltung_existing_user')}</div>
                <div className="location-verwaltung-add">
                  <input
                    value={userFilter}
                    onChange={(event) => setUserFilter(event.target.value)}
                    placeholder={t('verwaltung_user_filter_placeholder')}
                    className="location-verwaltung-user-filter"
                    data-testid="verwaltung-permissions-user-filter"
                  />
                  <select
                    value={newUserId}
                    onChange={(event) => setNewUserId(event.target.value)}
                    className="location-verwaltung-user-select"
                    data-testid="verwaltung-permissions-user"
                  >
                    <option value="">
                      {t('verwaltung_select_user_count', { count: availableUsers.length })}
                    </option>
                    {availableUsers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {accessUserLabel(user)}
                      </option>
                    ))}
                  </select>
                  <PillButton label={t('rechte_add_confirm')} onClick={addUser} testId="verwaltung-permissions-add" />
                </div>

                <div className="location-verwaltung-section-title">{t('verwaltung_invite_title')}</div>
                <div className="location-verwaltung-invite" data-testid="verwaltung-permissions-invite">
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    placeholder={t('rechte_invite_email')}
                    className="location-verwaltung-invite-email"
                    data-testid="verwaltung-invite-email"
                  />
                  <input
                    value={inviteFirstName}
                    onChange={(event) => setInviteFirstName(event.target.value)}
                    placeholder={t('rechte_invite_first_name')}
                    data-testid="verwaltung-invite-first-name"
                  />
                  <input
                    value={inviteLastName}
                    onChange={(event) => setInviteLastName(event.target.value)}
                    placeholder={t('rechte_invite_last_name')}
                    data-testid="verwaltung-invite-last-name"
                  />
                  <PillButton
                    label={t('verwaltung_invite_send')}
                    onClick={inviteUser}
                    disabled={!inviteValid || inviting}
                    testId="verwaltung-invite-send"
                  />
                </div>
                <div className="location-verwaltung-invite-hint">{t('rechte_invite_hint')}</div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default LocationVerwaltungView;
