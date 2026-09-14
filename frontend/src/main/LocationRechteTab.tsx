import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { Spinner } from 'react-bootstrap';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import LabeledInput from '../components/ui/kit/LabeledInput';
import type { PortalOutletContext } from './LocationPortalLayout';

type AccessRule = {
  id: number;
  user?: number | null;
  user_name?: string | null;
  user_email?: string | null;
  is_staff?: boolean;
  transport?: number | null;
  type?: number | null;
};

type AccessUser = {
  id: number;
  username: string;
  email?: string | null;
  mobile?: string | null;
};

// ProgeoAccess.NotifiTrans / NotifiTypes bit values.
const TRANSPORT_OPTIONS = [
  { value: 0, labelKey: 'rechte_transport_silent' },
  { value: 1, labelKey: 'rechte_transport_email' },
  { value: 2, labelKey: 'rechte_transport_sms' },
  { value: 4, labelKey: 'rechte_transport_both' },
];
const TYPE_OPTIONS = [
  { value: 1, labelKey: 'rechte_type_alarm' },
  { value: 2, labelKey: 'rechte_type_timeout' },
  { value: 4, labelKey: 'rechte_type_news' },
];

const initialsOf = (name?: string | null) =>
  (name || '?')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '?';

/**
 * Rechte (Berechtigungen): who has access to this object, and how they're
 * notified - the real content that used to live (mislabeled) on the
 * Benachrichtigungen route. Fully backed by ProgeoAccess via the existing
 * /v1/location/:id/access/ endpoints; no backend change needed here.
 *
 * The mockup's "Rolle" (Nutzer/Kundenadmin) pill picker is deliberately not
 * reproduced: permissions in this app are global per user (Django module
 * permissions), not stored per-object anywhere ProgeoAccess or any other
 * model can represent - a picker here would not actually do anything.
 */
const LocationRechteTab = () => {
  const { locationId } = useOutletContext<PortalOutletContext>();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { hasPermission } = usePermissions();
  const { t } = useTranslation();

  const canEdit = hasPermission('module_notifications_edit');
  const canAdd = hasPermission('module_notifications_add');

  const [rules, setRules] = useState<AccessRule[]>([]);
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [newUserId, setNewUserId] = useState('');
  const [contactEdit, setContactEdit] = useState<{
    userId: number;
    field: 'email' | 'mobile';
    value: string;
  } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/access/`,
      (response) => {
        const allRules = (response?.data?.access || []) as AccessRule[];
        setRules(allRules.filter((rule) => !rule.is_staff));
        setUsers((response?.data?.users || []) as AccessUser[]);
        setLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not load access rules: ${reason}`);
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar, locationId]);

  useEffect(() => {
    load();
  }, [load]);

  const availableUsers = useMemo(
    () => users.filter((user) => !rules.some((rule) => rule.user === user.id)),
    [users, rules],
  );

  const setTransport = (rule: AccessRule, value: number) => {
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/access/`,
      { id: rule.id, transport: value, type: rule.type ?? 0 },
      (response) => {
        const saved = response?.data?.access as AccessRule | undefined;
        if (saved) {
          setRules((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
        }
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not update: ${reason}`);
      },
    );
  };

  const toggleType = (rule: AccessRule, bit: number) => {
    const nextType = (rule.type ?? 0) & bit ? (rule.type ?? 0) & ~bit : (rule.type ?? 0) | bit;
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/access/`,
      { id: rule.id, transport: rule.transport ?? 0, type: nextType },
      (response) => {
        const saved = response?.data?.access as AccessRule | undefined;
        if (saved) {
          setRules((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
        }
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not update: ${reason}`);
      },
    );
  };

  const addUser = () => {
    if (!newUserId) {
      return;
    }
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/access/`,
      { user_id: Number(newUserId), transport: 1, type: 1 },
      (response) => {
        const saved = response?.data?.access as AccessRule | undefined;
        if (saved) {
          setRules((prev) => [...prev, saved]);
        }
        showSuccessBar(enqueueSnackbar, t('rechte_added'));
        setNewUserId('');
        setAddOpen(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not add user: ${reason}`);
      },
    );
  };

  const removeRule = (rule: AccessRule) => {
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/access/delete/`,
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

  const saveContact = () => {
    if (!contactEdit) {
      return;
    }
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/access/user/`,
      { user_id: contactEdit.userId, [contactEdit.field]: contactEdit.value.trim() },
      (response) => {
        const updated = response?.data?.user as AccessUser | undefined;
        if (updated) {
          setUsers((prev) => prev.map((user) => (user.id === updated.id ? updated : user)));
        }
        setContactEdit(null);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not update contact data: ${reason}`);
      },
    );
  };

  return (
    <PanelCard
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {t('rechte_title')}
          <span style={{ fontSize: 12.5, color: '#8B8383', fontWeight: 400 }}>
            {rules.length}
          </span>
        </span>
      }
      actions={
        canAdd && (
          <PillButton
            variant="solid"
            label={t('rechte_add_user')}
            onClick={() => setAddOpen((open) => !open)}
          />
        )
      }
    >
      {loading ? (
        <div className="d-flex justify-content-center py-4 text-muted">
          <Spinner animation="border" size="sm" />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {addOpen && (
            <div
              style={{
                background: 'var(--progeo-surface)',
                borderRadius: 14,
                padding: 16,
                boxShadow: 'inset 0 0 0 1.5px var(--progeo-orange)',
                display: 'flex',
                gap: 12,
                alignItems: 'flex-end',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ minWidth: 220 }}>
                <span
                  style={{
                    display: 'block',
                    fontSize: 10.5,
                    letterSpacing: '.08em',
                    textTransform: 'uppercase',
                    color: '#8B8383',
                    fontWeight: 500,
                    marginBottom: 5,
                  }}
                >
                  {t('rechte_select_user')}
                </span>
                <select
                  value={newUserId}
                  onChange={(event) => setNewUserId(event.target.value)}
                  style={{
                    height: 38,
                    border: 'none',
                    borderRadius: 10,
                    background: '#EFECEC',
                    padding: '0 12px',
                    fontFamily: 'inherit',
                    fontSize: 13.5,
                    color: 'var(--progeo-blue)',
                    width: '100%',
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
              </div>
              <PillButton label={t('rechte_add_confirm')} onClick={addUser} />
              <PillButton
                variant="ghost"
                label={t('rechte_cancel')}
                onClick={() => setAddOpen(false)}
              />
            </div>
          )}

          {rules.length === 0 && (
            <div style={{ background: 'var(--progeo-surface)', borderRadius: 14, padding: '22px 16px', fontSize: 13, color: '#8B8383' }}>
              {t('rechte_empty')}
            </div>
          )}

          {rules.map((rule) => {
            const user = users.find((candidate) => candidate.id === rule.user);
            const hasEmail = Boolean(user?.email?.trim());
            const hasMobile = Boolean(user?.mobile?.trim());
            const editingEmail =
              contactEdit && contactEdit.userId === rule.user && contactEdit.field === 'email'
                ? contactEdit
                : null;
            const editingMobile =
              contactEdit && contactEdit.userId === rule.user && contactEdit.field === 'mobile'
                ? contactEdit
                : null;
            return (
              <div
                key={rule.id}
                style={{ background: 'var(--progeo-surface)', borderRadius: 14, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: '50%',
                      background: 'var(--progeo-track-soft)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--progeo-blue)',
                      flexShrink: 0,
                    }}
                  >
                    {initialsOf(rule.user_name)}
                  </div>
                  <div style={{ flex: 1, minWidth: 140 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{rule.user_name || `#${rule.user}`}</div>
                    <div style={{ fontSize: 12, color: '#8B8383' }}>{rule.user_email || '–'}</div>
                  </div>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => removeRule(rule)}
                      title={t('rechte_revoke')}
                      style={{
                        height: 32,
                        padding: '0 12px',
                        border: 'none',
                        borderRadius: 9,
                        background: '#FBEAE4',
                        color: '#C44D26',
                        fontFamily: 'inherit',
                        fontSize: 12.5,
                        fontWeight: 500,
                        cursor: 'pointer',
                      }}
                    >
                      {t('rechte_revoke')}
                    </button>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', paddingLeft: 48 }}>
                  <div>
                    <div style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: '#8B8383', fontWeight: 500, marginBottom: 5 }}>
                      {t('rechte_channel')}
                    </div>
                    <div style={{ display: 'flex', gap: 3, background: 'var(--progeo-track-soft)', borderRadius: 'var(--progeo-radius-pill)', padding: 3 }}>
                      {TRANSPORT_OPTIONS.map((option) => {
                        const disabled =
                          !canEdit ||
                          (option.value === 1 && !hasEmail) ||
                          (option.value === 2 && !hasMobile) ||
                          (option.value === 4 && (!hasEmail || !hasMobile));
                        return (
                          <PillButton
                            key={option.value}
                            label={t(option.labelKey)}
                            active={(rule.transport ?? 0) === option.value}
                            disabled={disabled}
                            onClick={() => setTransport(rule, option.value)}
                          />
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: '#8B8383', fontWeight: 500, marginBottom: 5 }}>
                      {t('rechte_type')}
                    </div>
                    <div style={{ display: 'flex', gap: 3, background: 'var(--progeo-track-soft)', borderRadius: 'var(--progeo-radius-pill)', padding: 3 }}>
                      {TYPE_OPTIONS.map((option) => (
                        <PillButton
                          key={option.value}
                          label={t(option.labelKey)}
                          active={((rule.type ?? 0) & option.value) !== 0}
                          disabled={!canEdit}
                          onClick={() => toggleType(rule, option.value)}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                {canEdit && (!hasEmail || !hasMobile) && (
                  <div style={{ paddingLeft: 48, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                    {!hasEmail &&
                      (editingEmail ? (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <LabeledInput
                            label={t('rechte_field_email')}
                            value={editingEmail.value}
                            onChange={(value) => setContactEdit({ ...editingEmail, value })}
                          />
                          <PillButton label={t('rechte_save')} onClick={saveContact} />
                        </div>
                      ) : (
                        <PillButton
                          variant="ghost"
                          label={t('rechte_add_email')}
                          onClick={() =>
                            rule.user &&
                            setContactEdit({ userId: rule.user, field: 'email', value: '' })
                          }
                        />
                      ))}
                    {!hasMobile &&
                      (editingMobile ? (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <LabeledInput
                            label={t('rechte_field_mobile')}
                            value={editingMobile.value}
                            onChange={(value) => setContactEdit({ ...editingMobile, value })}
                          />
                          <PillButton label={t('rechte_save')} onClick={saveContact} />
                        </div>
                      ) : (
                        <PillButton
                          variant="ghost"
                          label={t('rechte_add_mobile')}
                          onClick={() =>
                            rule.user &&
                            setContactEdit({ userId: rule.user, field: 'mobile', value: '' })
                          }
                        />
                      ))}
                  </div>
                )}
              </div>
            );
          })}

          {!canEdit && !canAdd && (
            <span style={{ fontSize: 12.5, color: '#8B8383' }}>{t('ui_no_permission_edit')}</span>
          )}
        </div>
      )}
    </PanelCard>
  );
};

export default LocationRechteTab;
