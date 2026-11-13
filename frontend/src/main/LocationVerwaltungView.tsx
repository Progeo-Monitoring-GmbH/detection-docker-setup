import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Spinner } from 'react-bootstrap';
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
import FavoriteStar from './FavoriteStar';
import { repeatedTestId } from '../testIds';
import './LocationVerwaltungView.css';

type VerwaltungRow = {
  id: number;
  account_id: number;
  nr: number | null;
  name: string | null;
  city: string | null;
  owner: string | null;
  status: Severity | 'ok';
};

type Kpis = { ok: number; beobachten: number; alarm: number; kritisch: number };

type AccessRule = {
  id: number;
  user?: number | null;
  user_name?: string | null;
  user_email?: string | null;
  is_staff?: boolean;
  transport?: number | null;
};

type AccessUser = { id: number; username: string; email?: string | null };

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
  const [kpis, setKpis] = useState<Kpis>({ ok: 0, beobachten: 0, alarm: 0, kritisch: 0 });
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('Alle');

  const [permsFor, setPermsFor] = useState<VerwaltungRow | null>(null);
  const [rules, setRules] = useState<AccessRule[]>([]);
  const [accessUsers, setAccessUsers] = useState<AccessUser[]>([]);
  const [permsLoading, setPermsLoading] = useState(false);
  const [newUserId, setNewUserId] = useState('');

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      '/v1/location/admin_overview/',
      (response) => {
        setRows((response?.data?.objects || []) as VerwaltungRow[]);
        setKpis((response?.data?.kpis || { ok: 0, beobachten: 0, alarm: 0, kritisch: 0 }) as Kpis);
        setLoading(false);
      },
      (error) => {
        if (error?.response?.status === 400 || error?.response?.status === 403) {
          setDenied(true);
        } else {
          showRequestError(enqueueSnackbar, 'Could not load objects', error);
        }
        setLoading(false);
      },
    );
    // Once on mount: auth changes with every token refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (statusFilter !== 'Alle' && row.status !== statusFilter) {
        return false;
      }
      return matchesLocationSearch(
        { name: row.name, project_id: row.nr, city: row.city, owner: row.owner },
        search,
      );
    });
  }, [rows, search, statusFilter]);

  const kpiTiles = [
    { label: t('verwaltung_kpi_total'), value: String(rows.length) },
    { label: t('ui_severity_kritisch'), value: String(kpis.kritisch), valueColor: '#C44D26' },
    { label: t('ui_severity_alarm'), value: String(kpis.alarm), valueColor: '#EB633B' },
    { label: t('ui_severity_beobachten'), value: String(kpis.beobachten), valueColor: '#9A7208' },
  ];

  const loadPerms = useCallback((row: VerwaltungRow) => {
    setPermsFor(row);
    setPermsLoading(true);
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

  const availableUsers = useMemo(
    () => accessUsers.filter((user) => !rules.some((rule) => rule.user === user.id)),
    [accessUsers, rules],
  );

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
              <div className="location-verwaltung-scroll">
                <div className="location-verwaltung-table" data-testid="verwaltung-table">
                  <div className="location-verwaltung-grid location-verwaltung-head">
                    <span>{t('verwaltung_col_nr')}</span>
                    <span>{t('verwaltung_col_object')}</span>
                    <span>{t('verwaltung_col_city')}</span>
                    <span>{t('verwaltung_col_owner')}</span>
                    <span>{t('verwaltung_col_status')}</span>
                    <span className="location-verwaltung-right">{t('verwaltung_col_actions')}</span>
                  </div>
                  {filtered.map((row) => (
                    <div
                      key={`${row.account_id}-${row.id}`}
                      className="location-verwaltung-grid location-verwaltung-row"
                      {...repeatedTestId('verwaltung-row', `${row.account_id}-${row.id}`)}
                    >
                      <span className="location-verwaltung-nr">{row.nr ?? '–'}</span>
                      <span className="location-verwaltung-name-cell">
                        <FavoriteStar locationId={row.id} size={26} />
                        <span className="location-verwaltung-name">
                          {row.name || '–'}
                        </span>
                      </span>
                      <span className="location-verwaltung-dim">{row.city || '–'}</span>
                      <span className="location-verwaltung-dim location-verwaltung-ellipsis">
                        {row.owner || '–'}
                      </span>
                      <span {...repeatedTestId('verwaltung-row-status', `${row.account_id}-${row.id}`)}>
                        {row.status === 'ok' ? (
                          <span className="location-verwaltung-ok">{t('status_kpi_ok')}</span>
                        ) : (
                          <SeverityBadge severity={row.status} label={t(`ui_severity_${row.status}`)} />
                        )}
                      </span>
                      <span className="location-verwaltung-row-actions">
                        <PillButton
                          label={t('verwaltung_permissions')}
                          onClick={() => loadPerms(row)}
                          testId="verwaltung-row-permissions"
                          testKey={`${row.account_id}-${row.id}`}
                        />
                        <Link
                          to={`/location/${row.id}/status`}
                          className="location-verwaltung-open"
                          {...repeatedTestId('verwaltung-row-open', `${row.account_id}-${row.id}`)}
                        >
                          {t('verwaltung_open')}
                        </Link>
                      </span>
                    </div>
                  ))}
                </div>
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

                <div className="location-verwaltung-add">
                  <select
                    value={newUserId}
                    onChange={(event) => setNewUserId(event.target.value)}
                    className="location-verwaltung-user-select"
                    data-testid="verwaltung-permissions-user"
                  >
                    <option value="">{t('rechte_select_user_placeholder')}</option>
                    {availableUsers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.username}
                        {user.email ? ` (${user.email})` : ''}
                      </option>
                    ))}
                  </select>
                  <PillButton label={t('rechte_add_confirm')} onClick={addUser} testId="verwaltung-permissions-add" />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default LocationVerwaltungView;
