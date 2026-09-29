import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useOutletContext } from 'react-router';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { Spinner } from 'react-bootstrap';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import LabeledInput from '../components/ui/kit/LabeledInput';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import type { PortalOutletContext } from './LocationPortalLayout';
import { formatDateTime } from './dateFormat';

type AccessRule = {
  id: number;
  user?: number | null;
  transport?: number | null;
  type?: number | null;
};

type UserContact = {
  user_id: number;
  username: string;
  full_name?: string | null;
  email?: string | null;
  mobile?: string | null;
  last_login?: string | null;
};

/**
 * One person with access to this object: "account" = member of the
 * object's Account (multi-access, all its objects), "single" = only a
 * ProgeoAccess row for this object. `rule` is their notification rule for
 * this object, if any (account members may have none = silent).
 */
type Member = UserContact & {
  access: Access;
  single: boolean;
  rule: AccessRule | null;
};

type Scope = 'single' | 'account';
/** "staff" = ProGeo team: sees every object; managed in Einstellungen. */
type Access = Scope | 'staff';

const ACCESS_LABEL_KEYS: Record<Access, string> = {
  single: 'rechte_scope_single',
  account: 'rechte_scope_account',
  staff: 'rechte_scope_staff',
};

const BADGE_COLORS: Record<Access, { background: string; color: string }> = {
  single: { background: '#FBEAE4', color: '#C44D26' },
  account: { background: '#E3ECF4', color: 'var(--progeo-blue)' },
  staff: { background: 'var(--progeo-track-soft)', color: '#6E6868' },
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

const displayName = (user: UserContact) => user.full_name || user.username;

const fieldLabelStyle: CSSProperties = {
  fontSize: 10.5,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: '#8B8383',
  fontWeight: 500,
  marginBottom: 5,
};

const segmentTrackStyle: CSSProperties = {
  display: 'flex',
  gap: 3,
  background: 'var(--progeo-track-soft)',
  borderRadius: 'var(--progeo-radius-pill)',
  padding: 3,
  width: 'fit-content',
};

const ScopeBadge = ({ scope, label }: { scope: Access; label: string }) => (
  <span
    style={{
      fontSize: 11,
      fontWeight: 500,
      padding: '2px 9px',
      borderRadius: 'var(--progeo-radius-pill)',
      ...BADGE_COLORS[scope],
      whiteSpace: 'nowrap',
    }}
  >
    {label}
  </span>
);

/**
 * Rechte (Berechtigungen): everyone who can see this object and how they are
 * notified. Access comes from two sources (see backend
 * progeo/helper/location_access.py):
 *
 * - Account membership (multi-access): sees every object of the account.
 *   Can't be revoked here, since that would affect all of the account's
 *   objects - shown with a hint instead.
 * - A ProgeoAccess row (single-access): sees only this object. Revoking
 *   deletes the row.
 *
 * The ProgeoAccess row doubles as the notification rule, so account members
 * get one created on demand the first time their notifications are changed.
 */
const LocationRechteTab = () => {
  const { locationId } = useOutletContext<PortalOutletContext>();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { hasPermission } = usePermissions();
  const { t } = useTranslation();

  const canEdit = hasPermission('module_notifications_edit');
  const canAdd = hasPermission('module_notifications_add');

  const [members, setMembers] = useState<Member[]>([]);
  const [candidates, setCandidates] = useState<UserContact[]>([]);
  const [canGrantAccount, setCanGrantAccount] = useState(false);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [newUserId, setNewUserId] = useState('');
  const [newScope, setNewScope] = useState<Scope>('single');
  const [adding, setAdding] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Member | null>(null);
  const [revoking, setRevoking] = useState(false);
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
        setMembers((response?.data?.members || []) as Member[]);
        setCandidates((response?.data?.candidates || []) as UserContact[]);
        setCanGrantAccount(Boolean(response?.data?.can_grant_account));
        setLoading(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not load access rules', error);
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar, locationId]);

  useEffect(() => {
    load();
  }, [load]);

  const updateMember = (userId: number, patch: Partial<Member>) =>
    setMembers((prev) => prev.map((m) => (m.user_id === userId ? { ...m, ...patch } : m)));

  // Updates the member's rule, or creates one (account members without a
  // rule are silent by default).
  const saveRule = (member: Member, transport: number, type: number) => {
    const body = member.rule
      ? { id: member.rule.id, transport, type }
      : { user_id: member.user_id, transport, type };
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/access/`,
      body,
      (response) => {
        const saved = response?.data?.access as AccessRule | undefined;
        if (saved) {
          updateMember(member.user_id, { rule: saved });
        }
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not update', error);
      },
    );
  };

  const setTransport = (member: Member, value: number) =>
    saveRule(member, value, member.rule?.type ?? (value ? 1 : 0));

  const toggleType = (member: Member, bit: number) => {
    const current = member.rule?.type ?? 0;
    saveRule(member, member.rule?.transport ?? 0, current & bit ? current & ~bit : current | bit);
  };

  const addUser = () => {
    if (!newUserId) {
      return;
    }
    setAdding(true);
    const done = () => {
      showSuccessBar(enqueueSnackbar, t('rechte_added'));
      setAdding(false);
      setNewUserId('');
      setNewScope('single');
      setAddOpen(false);
      load();
    };
    const failed = (error: { response?: { data?: { reason?: string } }; message: string }) => {
      showRequestError(enqueueSnackbar, 'Could not add user', error);
      setAdding(false);
    };
    if (newScope === 'account') {
      void axiosConfig.perform_post(
        auth,
        `/v1/location/${locationId}/access/account-member/`,
        { user_id: Number(newUserId) },
        done,
        failed,
      );
    } else {
      void axiosConfig.perform_post(
        auth,
        `/v1/location/${locationId}/access/`,
        { user_id: Number(newUserId), transport: 1, type: 1 },
        done,
        failed,
      );
    }
  };

  const revoke = () => {
    if (!revokeTarget?.rule) {
      return;
    }
    setRevoking(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/access/delete/`,
      { id: revokeTarget.rule.id },
      () => {
        showSuccessBar(enqueueSnackbar, t('rechte_removed'));
        setRevoking(false);
        setRevokeTarget(null);
        load();
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not remove access', error);
        setRevoking(false);
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
        const updated = response?.data?.user as
          | { id: number; email?: string | null; mobile?: string | null }
          | undefined;
        if (updated) {
          updateMember(updated.id, { email: updated.email, mobile: updated.mobile });
        }
        setContactEdit(null);
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not update contact data', error);
      },
    );
  };

  const countOf = (access: Access) => members.filter((m) => m.access === access).length;

  const renderContactFix = (member: Member) => {
    const hasEmail = Boolean(member.email?.trim());
    const hasMobile = Boolean(member.mobile?.trim());
    if (!canEdit || (hasEmail && hasMobile)) {
      return null;
    }
    const fields = [
      !hasEmail && { field: 'email' as const, label: 'rechte_field_email', add: 'rechte_add_email' },
      !hasMobile && { field: 'mobile' as const, label: 'rechte_field_mobile', add: 'rechte_add_mobile' },
    ].filter(Boolean) as { field: 'email' | 'mobile'; label: string; add: string }[];
    return (
      <div style={{ paddingLeft: 48, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {fields.map(({ field, label, add }) => {
          const editing =
            contactEdit && contactEdit.userId === member.user_id && contactEdit.field === field
              ? contactEdit
              : null;
          return editing ? (
            <div key={field} style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
              <LabeledInput
                label={t(label)}
                value={editing.value}
                onChange={(value) => setContactEdit({ ...editing, value })}
              />
              <PillButton label={t('rechte_save')} onClick={saveContact} />
            </div>
          ) : (
            <PillButton
              key={field}
              variant="ghost"
              label={t(add)}
              onClick={() => setContactEdit({ userId: member.user_id, field, value: '' })}
            />
          );
        })}
      </div>
    );
  };

  const renderMember = (member: Member) => {
    const hasEmail = Boolean(member.email?.trim());
    const hasMobile = Boolean(member.mobile?.trim());
    const transport = member.rule?.transport ?? 0;
    const type = member.rule?.type ?? 0;
    // Only single-access can be revoked here; account/staff access is
    // broader than this object. Staff notification rules are their
    // Objektleitung assignment (Einstellungen tab), so read-only here.
    const revokeLocked = member.access !== 'single';
    const isStaff = member.access === 'staff';
    const canEditRule = canEdit && !isStaff;
    const lockedHint = isStaff ? t('rechte_staff_hint') : t('rechte_account_revoke_hint');
    return (
      <div
        key={member.user_id}
        style={{
          background: 'var(--progeo-surface)',
          borderRadius: 14,
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
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
            {initialsOf(displayName(member))}
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{displayName(member)}</span>
              <ScopeBadge
                scope={member.access}
                label={t(ACCESS_LABEL_KEYS[member.access])}
              />
            </div>
            <div style={{ fontSize: 12, color: '#8B8383' }}>{member.email || '–'}</div>
          </div>
          <div style={{ minWidth: 110 }}>
            <div style={{ ...fieldLabelStyle, marginBottom: 2 }}>{t('rechte_last_login')}</div>
            <div style={{ fontSize: 12.5, color: '#6E6868' }}>
              {member.last_login ? formatDateTime(member.last_login) : t('rechte_never_logged_in')}
            </div>
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={() => setRevokeTarget(member)}
              disabled={revokeLocked}
              title={revokeLocked ? lockedHint : t('rechte_revoke')}
              style={{
                height: 32,
                padding: '0 12px',
                border: 'none',
                borderRadius: 9,
                background: revokeLocked ? 'var(--progeo-track-soft)' : '#FBEAE4',
                color: revokeLocked ? '#A9A2A2' : '#C44D26',
                fontFamily: 'inherit',
                fontSize: 12.5,
                fontWeight: 500,
                cursor: revokeLocked ? 'not-allowed' : 'pointer',
              }}
            >
              {t('rechte_revoke')}
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', paddingLeft: 48 }}>
          <div>
            <div style={fieldLabelStyle}>{t('rechte_channel')}</div>
            <div style={segmentTrackStyle}>
              {TRANSPORT_OPTIONS.map((option) => {
                const disabled =
                  !canEditRule ||
                  (option.value === 1 && !hasEmail) ||
                  (option.value === 2 && !hasMobile) ||
                  (option.value === 4 && (!hasEmail || !hasMobile));
                return (
                  <PillButton
                    key={option.value}
                    label={t(option.labelKey)}
                    active={transport === option.value}
                    disabled={disabled}
                    onClick={() => setTransport(member, option.value)}
                  />
                );
              })}
            </div>
          </div>
          <div>
            <div style={fieldLabelStyle}>{t('rechte_type')}</div>
            <div style={segmentTrackStyle}>
              {TYPE_OPTIONS.map((option) => (
                <PillButton
                  key={option.value}
                  label={t(option.labelKey)}
                  active={(type & option.value) !== 0}
                  disabled={!canEditRule || transport === 0}
                  onClick={() => toggleType(member, option.value)}
                />
              ))}
            </div>
          </div>
        </div>

        {!isStaff && renderContactFix(member)}

        {revokeLocked && canEdit && (
          <div style={{ paddingLeft: 48, fontSize: 12, color: '#8B8383' }}>{lockedHint}</div>
        )}
      </div>
    );
  };

  return (
    <>
      <PanelCard
        title={
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            {t('rechte_title')}
            <span style={{ fontSize: 12.5, color: '#8B8383', fontWeight: 400 }}>
              {t('rechte_summary', {
                account: countOf('account'),
                single: countOf('single'),
                staff: countOf('staff'),
              })}
            </span>
          </span>
        }
        actions={
          canAdd && (
            <button
              type="button"
              onClick={() => setAddOpen((open) => !open)}
              style={{
                height: 36,
                padding: '0 16px',
                border: 'none',
                borderRadius: 10,
                background: 'var(--progeo-orange)',
                color: '#fff',
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                boxShadow: '0 4px 14px rgba(235, 99, 59, .28)',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              {t('rechte_add_user')}
            </button>
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
                  gap: 16,
                  alignItems: 'flex-end',
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ minWidth: 240, flex: '1 1 240px' }}>
                  <div style={fieldLabelStyle}>{t('rechte_select_user')}</div>
                  {candidates.length === 0 ? (
                    <div style={{ fontSize: 13, color: '#8B8383', height: 38, display: 'flex', alignItems: 'center' }}>
                      {t('rechte_no_candidates')}
                    </div>
                  ) : (
                    <select
                      value={newUserId}
                      onChange={(event) => setNewUserId(event.target.value)}
                      autoComplete="off"
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
                      {candidates.map((user) => (
                        <option key={user.user_id} value={user.user_id}>
                          {displayName(user)}
                          {user.email ? ` (${user.email})` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                {canGrantAccount && (
                  <div>
                    <div style={fieldLabelStyle}>{t('rechte_scope')}</div>
                    <div style={segmentTrackStyle}>
                      {(['single', 'account'] as Scope[]).map((scope) => (
                        <PillButton
                          key={scope}
                          label={t(scope === 'account' ? 'rechte_scope_account' : 'rechte_scope_single')}
                          title={scope === 'account' ? t('rechte_scope_account_hint') : undefined}
                          active={newScope === scope}
                          onClick={() => setNewScope(scope)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <PillButton
                    label={t('rechte_add_confirm')}
                    onClick={addUser}
                    disabled={!newUserId || adding}
                  />
                  <PillButton
                    variant="ghost"
                    label={t('rechte_cancel')}
                    onClick={() => setAddOpen(false)}
                  />
                </div>
              </div>
            )}

            {members.length === 0 && (
              <div
                style={{
                  background: 'var(--progeo-surface)',
                  borderRadius: 14,
                  padding: '22px 16px',
                  fontSize: 13,
                  color: '#8B8383',
                }}
              >
                {t('rechte_empty')}
              </div>
            )}

            {members.map(renderMember)}

            {!canEdit && !canAdd && (
              <span style={{ fontSize: 12.5, color: '#8B8383' }}>{t('ui_no_permission_edit')}</span>
            )}
          </div>
        )}
      </PanelCard>
      <ConfirmDialog
        show={revokeTarget !== null}
        title={t('rechte_revoke_title')}
        message={t('rechte_revoke_message', { name: revokeTarget ? displayName(revokeTarget) : '' })}
        confirmLabel={t('rechte_revoke')}
        cancelLabel={t('rechte_cancel')}
        confirming={revoking}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={revoke}
      />
    </>
  );
};

export default LocationRechteTab;
