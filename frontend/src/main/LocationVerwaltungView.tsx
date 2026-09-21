import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import KpiStrip from '../components/ui/kit/KpiStrip';
import SeverityBadge, { type Severity } from '../components/ui/kit/SeverityBadge';

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
          const reason = error?.response?.data?.reason || error.message;
          showErrorBar(enqueueSnackbar, `Could not load objects: ${reason}`);
        }
        setLoading(false);
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
    );
  }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== 'Alle' && row.status !== statusFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [row.name, row.nr != null ? String(row.nr) : '', row.city, row.owner]
        .filter(Boolean)
        .some((value) => (value as string).toLowerCase().includes(query));
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
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not load permissions: ${reason}`);
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
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not add user: ${reason}`);
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
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not remove access: ${reason}`);
      },
    );
  };

  const availableUsers = useMemo(
    () => accessUsers.filter((user) => !rules.some((rule) => rule.user === user.id)),
    [accessUsers, rules],
  );

  if (denied) {
    return (
      <PanelCard title={t('verwaltung_title')}>
        <div style={{ color: '#8B8383', fontSize: 13 }}>{t('verwaltung_denied')}</div>
      </PanelCard>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {loading ? (
        <div className="d-flex justify-content-center py-5 text-muted">
          <Spinner animation="border" />
        </div>
      ) : (
        <>
          <KpiStrip tiles={kpiTiles} />

          <PanelCard
            title={
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {t('verwaltung_objects_title')}
                <span style={{ fontSize: 12.5, color: '#8B8383', fontWeight: 400 }}>
                  {t('verwaltung_object_count', { count: filtered.length, total: rows.length })}
                </span>
              </span>
            }
            actions={
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('verwaltung_search_placeholder')}
                  style={{
                    height: 34,
                    minWidth: 220,
                    border: 'none',
                    borderRadius: 999,
                    background: 'var(--progeo-surface)',
                    boxShadow: '0 1px 4px rgba(11, 54, 89, .09)',
                    padding: '0 14px',
                    fontFamily: 'inherit',
                    fontSize: 13,
                    color: 'var(--progeo-blue)',
                  }}
                />
                <div
                  style={{
                    display: 'flex',
                    gap: 3,
                    background: 'var(--progeo-track)',
                    borderRadius: 'var(--progeo-radius-pill)',
                    padding: 3,
                    flexWrap: 'wrap',
                  }}
                >
                  {STATUS_FILTERS.map((filter) => (
                    <PillButton
                      key={filter.value}
                      label={t(filter.labelKey)}
                      active={statusFilter === filter.value}
                      onClick={() => setStatusFilter(filter.value)}
                    />
                  ))}
                </div>
              </div>
            }
          >
            {filtered.length === 0 ? (
              <div style={{ color: '#8B8383', fontSize: 13, padding: '10px 2px' }}>
                {t('verwaltung_no_objects')}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <div style={{ minWidth: 560 }}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '70px 1fr 100px 130px 110px 130px',
                      gap: 8,
                      padding: '6px 4px 10px',
                      fontSize: 10.5,
                      letterSpacing: '.06em',
                      textTransform: 'uppercase',
                      color: '#8B8383',
                      fontWeight: 500,
                    }}
                  >
                    <span>{t('verwaltung_col_nr')}</span>
                    <span>{t('verwaltung_col_object')}</span>
                    <span>{t('verwaltung_col_city')}</span>
                    <span>{t('verwaltung_col_owner')}</span>
                    <span>{t('verwaltung_col_status')}</span>
                    <span style={{ textAlign: 'right' }}>{t('verwaltung_col_actions')}</span>
                  </div>
                  {filtered.map((row) => (
                    <div
                      key={row.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '70px 1fr 100px 130px 110px 130px',
                        gap: 8,
                        padding: '10px 4px',
                        fontSize: 13,
                        borderTop: '1px solid var(--progeo-track)',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{row.nr ?? '–'}</span>
                      <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.name || '–'}
                      </span>
                      <span style={{ color: '#8B8383' }}>{row.city || '–'}</span>
                      <span style={{ color: '#8B8383', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.owner || '–'}
                      </span>
                      <span>
                        {row.status === 'ok' ? (
                          <span style={{ fontSize: 12, color: '#3F7A1C', fontWeight: 500 }}>{t('status_kpi_ok')}</span>
                        ) : (
                          <SeverityBadge severity={row.status} label={t(`ui_severity_${row.status}`)} />
                        )}
                      </span>
                      <span style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                        <PillButton label={t('verwaltung_permissions')} onClick={() => loadPerms(row)} />
                        <Link
                          to={`/location/${row.id}/status`}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            height: 32,
                            padding: '0 12px',
                            borderRadius: 'var(--progeo-radius-pill)',
                            background: 'var(--progeo-surface)',
                            fontSize: 12.5,
                            fontWeight: 500,
                            color: 'var(--progeo-orange)',
                          }}
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
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(7, 34, 58, .38)',
            zIndex: 75,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: '36px 16px',
            overflow: 'auto',
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: 'min(640px, 100%)',
              background: 'var(--progeo-panel-bg)',
              borderRadius: 20,
              boxShadow: '0 24px 60px rgba(11, 54, 89, .3)',
              padding: 22,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, letterSpacing: '.11em', textTransform: 'uppercase', color: '#8B8383', fontWeight: 500 }}>
                  {t('verwaltung_permissions')} · {permsFor.nr ?? permsFor.id}
                </div>
                <div style={{ fontSize: 17, fontWeight: 500, marginTop: 3 }}>{permsFor.name}</div>
              </div>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => setPermsFor(null)}
                aria-label={t('verwaltung_close')}
                style={{
                  width: 34,
                  height: 34,
                  border: 'none',
                  borderRadius: '50%',
                  background: 'var(--progeo-surface)',
                  cursor: 'pointer',
                  color: 'var(--progeo-blue)',
                }}
              >
                ×
              </button>
            </div>

            {permsLoading ? (
              <div className="d-flex justify-content-center py-4 text-muted">
                <Spinner animation="border" size="sm" />
              </div>
            ) : (
              <>
                {rules.length === 0 && (
                  <div style={{ background: 'var(--progeo-surface)', borderRadius: 14, padding: '20px 16px', fontSize: 13, color: '#8B8383' }}>
                    {t('rechte_empty')}
                  </div>
                )}
                {rules.map((rule) => (
                  <div
                    key={rule.id}
                    style={{ background: 'var(--progeo-surface)', borderRadius: 14, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500 }}>{rule.user_name || `#${rule.user}`}</div>
                      <div style={{ fontSize: 12, color: '#8B8383' }}>{rule.user_email || '–'}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeRule(rule)}
                      style={{
                        height: 30,
                        padding: '0 12px',
                        border: 'none',
                        borderRadius: 9,
                        background: '#FBEAE4',
                        color: '#C44D26',
                        fontFamily: 'inherit',
                        fontSize: 12.5,
                        fontWeight: 500,
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      {t('rechte_revoke')}
                    </button>
                  </div>
                ))}

                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    value={newUserId}
                    onChange={(event) => setNewUserId(event.target.value)}
                    style={{
                      height: 38,
                      border: 'none',
                      borderRadius: 10,
                      background: 'var(--progeo-surface)',
                      padding: '0 12px',
                      fontFamily: 'inherit',
                      fontSize: 13.5,
                      color: 'var(--progeo-blue)',
                      flex: '1 1 220px',
                    }}
                  >
                    <option value="">{t('rechte_select_user_placeholder')}</option>
                    {availableUsers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.username}
                        {user.email ? ` (${user.email})` : ''}
                      </option>
                    ))}
                  </select>
                  <PillButton label={t('rechte_add_confirm')} onClick={addUser} />
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
