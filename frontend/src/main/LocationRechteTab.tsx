import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { Spinner } from 'react-bootstrap';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import {
  showRequestError,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import LabeledInput from '../components/ui/kit/LabeledInput';
import PhoneInput from '../components/ui/PhoneInput';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import type { PortalOutletContext } from './LocationPortalLayout';
import { formatDate } from './dateFormat';
import { staffFlags } from './access';
import { useProgeoRole } from './roleModel';
import { repeatedTestId } from '../testIds';
import './LocationRechteTab.css';

type AccessRule = {
  id: number;
  user?: number | null;
  transport?: number | null;
  type?: number | null;
  /** Assigned as Objektleitung (Einstellungen) - the only staff customers see. */
  objektleitung?: boolean;
};

type UserContact = {
  user_id: number;
  username: string;
  full_name?: string | null;
  email?: string | null;
  mobile?: string | null;
  /** The user's messenger when it has an address (profile). */
  messenger?: 'signal' | 'whatsapp' | 'matrix' | null;
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

/** The location's account - "All objects of <name> (n objects)". */
type AccountInfo = { id: number; name: string; location_count: number };
/** "staff" = ProGeo team: sees every object; managed in Einstellungen. */
type Access = Scope | 'staff';

const ACCESS_LABEL_KEYS: Record<Access, string> = {
  single: 'rechte_scope_single',
  account: 'rechte_scope_account',
  staff: 'rechte_scope_staff',
};

// ProgeoAccess.NotifiTrans / NotifiTypes bit values. The channels combine;
// 4 is the legacy "E-Mail + SMS" value, read as (and saved as) 1 | 2.
const TRANSPORT_EMAIL = 1;
const TRANSPORT_SMS = 2;
const TRANSPORT_LEGACY_BOTH = 4;
const TRANSPORT_MESSENGER = 8;
const CHANNEL_OPTIONS = [
  { value: TRANSPORT_EMAIL, labelKey: 'rechte_transport_email' },
  { value: TRANSPORT_SMS, labelKey: 'rechte_transport_sms' },
  { value: TRANSPORT_MESSENGER, labelKey: 'rechte_transport_messenger' },
];
const MESSENGER_LABELS = {
  signal: 'Signal',
  whatsapp: 'WhatsApp',
  matrix: 'Matrix',
};
const channelBits = (transport: number) =>
  transport & TRANSPORT_LEGACY_BOTH
    ? (transport & ~TRANSPORT_LEGACY_BOTH) | TRANSPORT_EMAIL | TRANSPORT_SMS
    : transport;
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

/** The colours per scope: .location-rechte-badge--<scope> in LocationRechteTab.css. */
const ScopeBadge = ({ scope, label }: { scope: Access; label: string }) => (
  <span className={`location-rechte-badge location-rechte-badge--${scope}`}>
    {label}
  </span>
);

/** Answer of POST access/invite (backend helper/location_invites.py). */
type InviteStatus = 'granted' | 'invited' | 'already' | 'staff';

const INVITE_MESSAGE_KEYS: Record<InviteStatus, string> = {
  granted: 'rechte_invite_granted',
  invited: 'rechte_invite_invited',
  already: 'rechte_invite_already',
  staff: 'rechte_invite_staff',
};

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
 *
 * New people are added by email address (access/invite) - only by customer
 * admins and ProGeo staff, never by Kundennutzer. There is deliberately no
 * user picker: it listed the users of every customer sharing the account.
 */
/**
 * May the viewer change this member's notification rule? Their own always;
 * other people's with module_notifications_edit - a staff member's only as
 * staff.
 */
export const mayEditRule = ({
  canEdit,
  viewerIsStaff,
  memberIsStaff,
  isOwn,
}: {
  canEdit: boolean;
  viewerIsStaff: boolean;
  memberIsStaff: boolean;
  isOwn: boolean;
}) => isOwn || (canEdit && (!memberIsStaff || viewerIsStaff));

/**
 * May the viewer revoke this member's access here? Single access with
 * module_notifications_edit or as a mini admin of the account (backend:
 * can_revoke_account); account members only as such a mini admin (or
 * staff) - it takes them out of the account, so never oneself. ProGeo
 * staff see every object anyway: nothing to revoke.
 */
export const mayRevoke = ({
  access,
  isOwn,
  canEdit,
  canRevokeAccount,
}: {
  access: Access;
  isOwn: boolean;
  canEdit: boolean;
  canRevokeAccount: boolean;
}) => {
  if (access === 'single') {
    return canEdit || canRevokeAccount;
  }
  return access === 'account' && canRevokeAccount && !isOwn;
};

const LocationRechteTab = () => {
  const { locationId } = useOutletContext<PortalOutletContext>();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { hasPermission } = usePermissions();
  const { t } = useTranslation();

  const role = useProgeoRole();
  const canEdit = hasPermission('module_notifications_edit');
  // The backend decides (`can_invite`); the role check keeps the button
  // hidden in "view as normal user", where the backend still answers as staff.
  const [canInvite, setCanInvite] = useState(false);
  const canAdd =
    canInvite &&
    role !== 'nutzer' &&
    hasPermission('module_notifications_add') &&
    hasPermission('module_user_invitable');
  // Staff set their own and other staff's notifications here; customers
  // only ever see staff assigned as Objektleitung (read-only for them).
  const viewerIsStaff = staffFlags(auth?.user).isStaffOrSuperuser;
  // Everyone sets their own notifications (the backend allows it without
  // module_notifications_edit) - only other people's need the permission.
  const viewerId = (auth?.user as { user_id?: number } | null)?.user_id ?? null;

  const [members, setMembers] = useState<Member[]>([]);
  const [canGrantAccount, setCanGrantAccount] = useState(false);
  // Staff and mini admins of the account: take members out of it (Revoke) -
  // other mini admins too, never themselves.
  const [canRevokeAccount, setCanRevokeAccount] = useState(false);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  // Revoking at all needs module_user_revokable (the backend checks the
  // same) - which members it unlocks: mayRevoke.
  const revokable = hasPermission('module_user_revokable');
  const canRevoke = revokable && (canEdit || canRevokeAccount);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteFirstName, setInviteFirstName] = useState('');
  const [inviteLastName, setInviteLastName] = useState('');
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
        const loaded = (response?.data?.members || []) as Member[];
        // ProGeo staff are for staff eyes only (the backend sends them to
        // nobody else - this keeps it so with an older backend, too).
        setMembers(
          viewerIsStaff
            ? loaded
            : loaded.filter((member) => member.access !== 'staff'),
        );
        setCanGrantAccount(Boolean(response?.data?.can_grant_account));
        setCanInvite(Boolean(response?.data?.can_invite));
        setCanRevokeAccount(Boolean(response?.data?.can_revoke_account));
        setAccount(
          (response?.data?.account as AccountInfo | undefined) ?? null,
        );
        setLoading(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not load access rules', error);
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar, locationId, viewerIsStaff]);

  useEffect(() => {
    load();
  }, [load]);

  const updateMember = (userId: number, patch: Partial<Member>) =>
    setMembers((prev) =>
      prev.map((m) => (m.user_id === userId ? { ...m, ...patch } : m)),
    );

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
    saveRule(
      member,
      member.rule?.transport ?? 0,
      current & bit ? current & ~bit : current | bit,
    );
  };

  const closeAdd = () => {
    setInviteEmail('');
    setInviteFirstName('');
    setInviteLastName('');
    setNewScope('single');
    setAddOpen(false);
  };

  const inviteValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail.trim());

  const addUser = () => {
    if (!inviteValid) {
      return;
    }
    const email = inviteEmail.trim();
    setAdding(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/access/invite/`,
      {
        email,
        scope: newScope,
        first_name: inviteFirstName.trim(),
        last_name: inviteLastName.trim(),
      },
      (response) => {
        const status = response?.data?.status as InviteStatus | undefined;
        const messageKey =
          (status && INVITE_MESSAGE_KEYS[status]) || 'rechte_added';
        showSuccessBar(enqueueSnackbar, t(messageKey, { email }));
        setAdding(false);
        closeAdd();
        load();
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not add user', error);
        setAdding(false);
      },
    );
  };

  const revoke = () => {
    if (!revokeTarget) {
      return;
    }
    // Account members leave the account; single access loses its rule.
    const body =
      revokeTarget.access === 'account'
        ? { user_id: revokeTarget.user_id, scope: 'account' }
        : revokeTarget.rule
          ? { id: revokeTarget.rule.id }
          : null;
    if (!body) {
      return;
    }
    setRevoking(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/access/delete/`,
      body,
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
      {
        user_id: contactEdit.userId,
        [contactEdit.field]: contactEdit.value.trim(),
      },
      (response) => {
        const updated = response?.data?.user as
          | { id: number; email?: string | null; mobile?: string | null }
          | undefined;
        if (updated) {
          updateMember(updated.id, {
            email: updated.email,
            mobile: updated.mobile,
          });
        }
        setContactEdit(null);
      },
      (error) => {
        showRequestError(
          enqueueSnackbar,
          'Could not update contact data',
          error,
        );
      },
    );
  };

  const countOf = (access: Access) =>
    members.filter((m) => m.access === access).length;

  // "All objects of Muster GmbH (12 objects)" - plain without the account (older backend).
  const accountScopeLabel = account
    ? t('rechte_scope_account_named', {
        account: account.name,
        count: account.location_count,
      })
    : t('rechte_scope_account');
  const accessLabel = (access: Access) =>
    access === 'account' ? accountScopeLabel : t(ACCESS_LABEL_KEYS[access]);

  const renderContactFix = (member: Member) => {
    const hasEmail = Boolean(member.email?.trim());
    const hasMobile = Boolean(member.mobile?.trim());
    if (!canEdit || (hasEmail && hasMobile)) {
      return null;
    }
    const fields = [
      !hasEmail && {
        field: 'email' as const,
        label: 'rechte_field_email',
        add: 'rechte_add_email',
      },
      !hasMobile && {
        field: 'mobile' as const,
        label: 'rechte_field_mobile',
        add: 'rechte_add_mobile',
      },
    ].filter(Boolean) as {
      field: 'email' | 'mobile';
      label: string;
      add: string;
    }[];
    return (
      <div
        className="location-rechte-contact-fix"
        {...repeatedTestId('rechte-contact-fix', member.user_id)}
      >
        {fields.map(({ field, label, add }) => {
          const editing =
            contactEdit &&
            contactEdit.userId === member.user_id &&
            contactEdit.field === field
              ? contactEdit
              : null;
          return editing ? (
            <div key={field} className="location-rechte-contact-edit">
              {field === 'mobile' ? (
                <PhoneInput
                  testId="rechte-contact-input"
                  label={t(label)}
                  value={editing.value}
                  onChange={(value) => setContactEdit({ ...editing, value })}
                />
              ) : (
                <LabeledInput
                  testId="rechte-contact-input"
                  label={t(label)}
                  value={editing.value}
                  onChange={(value) => setContactEdit({ ...editing, value })}
                />
              )}
              <PillButton
                testId="rechte-contact-save"
                label={t('rechte_save')}
                onClick={saveContact}
              />
            </div>
          ) : (
            <PillButton
              key={field}
              testId="rechte-contact-add"
              testKey={`${member.user_id}-${field}`}
              variant="ghost"
              label={t(add)}
              onClick={() =>
                setContactEdit({ userId: member.user_id, field, value: '' })
              }
            />
          );
        })}
      </div>
    );
  };

  const renderMember = (member: Member) => {
    const hasEmail = Boolean(member.email?.trim());
    const hasMobile = Boolean(member.mobile?.trim());
    const transport = channelBits(member.rule?.transport ?? 0);
    const available: Record<number, boolean> = {
      [TRANSPORT_EMAIL]: hasEmail,
      [TRANSPORT_SMS]: hasMobile,
      [TRANSPORT_MESSENGER]: Boolean(member.messenger),
    };
    const type = member.rule?.type ?? 0;
    // A staff member's notifications only staff can change (customers see
    // staff only as Objektleitung).
    const isStaff = member.access === 'staff';
    const isOwn = viewerId != null && member.user_id === viewerId;
    const revokeLocked = !mayRevoke({
      access: member.access,
      isOwn,
      canEdit: revokable && canEdit,
      canRevokeAccount: revokable && canRevokeAccount,
    });
    const canEditRule = mayEditRule({
      canEdit,
      viewerIsStaff,
      memberIsStaff: isStaff,
      isOwn,
    });
    const lockedHint = isStaff
      ? t(viewerIsStaff ? 'rechte_staff_hint_staff' : 'rechte_staff_hint')
      : isOwn && member.access === 'account' && canRevokeAccount
        ? t('rechte_revoke_own_hint')
        : t('rechte_account_revoke_hint');
    return (
      <div
        key={member.user_id}
        className="location-rechte-member"
        {...repeatedTestId('rechte-member', member.user_id)}
      >
        <div className="location-rechte-member-head">
          <div className="location-rechte-avatar">
            {initialsOf(displayName(member))}
          </div>
          <div className="location-rechte-member-info">
            <div className="location-rechte-member-name-row">
              <span
                className="location-rechte-member-name"
                {...repeatedTestId('rechte-member-name', member.user_id)}
              >
                {displayName(member)}
              </span>
              <ScopeBadge
                scope={member.access}
                label={accessLabel(member.access)}
              />
              {isStaff && member.rule?.objektleitung && (
                <ScopeBadge scope="account" label={t('rechte_objektleitung')} />
              )}
            </div>
            <div
              className="location-rechte-member-email"
              {...repeatedTestId('rechte-member-email', member.user_id)}
            >
              {member.email || '–'}
            </div>
          </div>
          <div className="location-rechte-last-login">
            <div className="location-rechte-label location-rechte-label--tight">
              {t('rechte_last_login')}
            </div>
            <div
              className="location-rechte-last-login-value"
              {...repeatedTestId('rechte-member-last-login', member.user_id)}
            >
              {member.last_login
                ? formatDate(member.last_login)
                : t('rechte_never_logged_in')}
            </div>
          </div>
          {canRevoke && (
            <button
              type="button"
              onClick={() => setRevokeTarget(member)}
              {...repeatedTestId('rechte-revoke', member.user_id)}
              disabled={revokeLocked}
              title={revokeLocked ? lockedHint : t('rechte_revoke')}
              className={
                revokeLocked
                  ? 'location-rechte-revoke location-rechte-revoke--locked'
                  : 'location-rechte-revoke'
              }
            >
              {t('rechte_revoke')}
            </button>
          )}
        </div>

        <div className="location-rechte-settings">
          <div>
            <div className="location-rechte-label">{t('rechte_channel')}</div>
            <div className="location-rechte-track">
              <PillButton
                testId="rechte-channel"
                testKey={`${member.user_id}-0`}
                label={t('rechte_transport_silent')}
                active={transport === 0}
                disabled={!canEditRule}
                onClick={() => setTransport(member, 0)}
              />
              {CHANNEL_OPTIONS.map((option) => {
                const active = (transport & option.value) !== 0;
                const isMessenger = option.value === TRANSPORT_MESSENGER;
                return (
                  <PillButton
                    key={option.value}
                    testId="rechte-channel"
                    testKey={`${member.user_id}-${option.value}`}
                    label={
                      isMessenger && member.messenger
                        ? MESSENGER_LABELS[member.messenger]
                        : t(option.labelKey)
                    }
                    active={active}
                    // An active channel can always be switched off.
                    disabled={
                      !canEditRule || (!active && !available[option.value])
                    }
                    title={
                      isMessenger && !member.messenger
                        ? t('rechte_messenger_missing')
                        : undefined
                    }
                    onClick={() =>
                      setTransport(member, transport ^ option.value)
                    }
                  />
                );
              })}
            </div>
          </div>
          <div>
            <div className="location-rechte-label">{t('rechte_type')}</div>
            <div className="location-rechte-track">
              {TYPE_OPTIONS.map((option) => (
                <PillButton
                  key={option.value}
                  testId="rechte-type"
                  testKey={`${member.user_id}-${option.value}`}
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

        {revokeLocked && canRevoke && (
          <div
            className="location-rechte-locked-hint"
            {...repeatedTestId('rechte-locked-hint', member.user_id)}
          >
            {lockedHint}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <PanelCard
        testId="page-location-rechte"
        title={
          <span className="location-rechte-title">
            {t('rechte_title')}
            <span
              className="location-rechte-summary"
              data-testid="rechte-summary"
            >
              {/* ProGeo staff are listed (and counted) for staff only - the backend sends them to nobody else. */}
              {t(viewerIsStaff ? 'rechte_summary' : 'rechte_summary_customer', {
                account: countOf('account'),
                single: countOf('single'),
                staff: countOf('staff'),
              })}
            </span>
          </span>
        }
        actions={
          canAdd && (
            <PillButton
              variant="accent"
              onClick={() => setAddOpen((open) => !open)}
              testId="rechte-add-button"
              icon={
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              }
              label={t('rechte_add_user')}
            />
          )
        }
      >
        {loading ? (
          <div
            className="d-flex justify-content-center py-4 text-muted"
            data-testid="rechte-loading"
          >
            <Spinner animation="border" size="sm" />
          </div>
        ) : (
          <div className="location-rechte-list" data-testid="rechte-list">
            {addOpen && (
              <div className="location-rechte-add" data-testid="rechte-add">
                <div className="location-rechte-add-user">
                  <LabeledInput
                    testId="rechte-invite-email"
                    label={t('rechte_invite_email')}
                    type="email"
                    autoComplete="off"
                    value={inviteEmail}
                    onChange={setInviteEmail}
                  />
                </div>
                <div className="location-rechte-add-name">
                  <LabeledInput
                    testId="rechte-invite-first-name"
                    label={t('rechte_invite_first_name')}
                    value={inviteFirstName}
                    onChange={setInviteFirstName}
                  />
                </div>
                <div className="location-rechte-add-name">
                  <LabeledInput
                    testId="rechte-invite-last-name"
                    label={t('rechte_invite_last_name')}
                    value={inviteLastName}
                    onChange={setInviteLastName}
                  />
                </div>
                <div className="location-rechte-add-hint">
                  {t('rechte_invite_hint')}
                </div>
                {canGrantAccount && (
                  <div>
                    <div className="location-rechte-label">
                      {t('rechte_scope')}
                    </div>
                    <div className="location-rechte-track">
                      {(['single', 'account'] as Scope[]).map((scope) => (
                        <PillButton
                          key={scope}
                          testId="rechte-scope"
                          testKey={scope}
                          label={
                            scope === 'account'
                              ? accountScopeLabel
                              : t('rechte_scope_single')
                          }
                          title={
                            scope === 'account'
                              ? t('rechte_scope_account_hint')
                              : undefined
                          }
                          active={newScope === scope}
                          onClick={() => setNewScope(scope)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <div className="location-rechte-add-actions">
                  <PillButton
                    variant="accent"
                    testId="rechte-add-confirm"
                    onClick={addUser}
                    disabled={!inviteValid || adding}
                    icon={adding ? <Spinner animation="border" size="sm" /> : undefined}
                    label={t('rechte_add_confirm')}
                  />
                  <button
                    type="button"
                    className="location-rechte-revoke location-rechte-cancel"
                    data-testid="rechte-add-cancel"
                    onClick={closeAdd}
                  >
                    {t('rechte_cancel')}
                  </button>
                </div>
              </div>
            )}

            {members.length === 0 && (
              <div className="location-rechte-empty" data-testid="rechte-empty">
                {t('rechte_empty')}
              </div>
            )}

            {members.map(renderMember)}

            {!canEdit && !canAdd && (
              <span
                className="location-rechte-no-permission"
                data-testid="rechte-no-permission"
              >
                {t('rechte_own_only')}
              </span>
            )}
          </div>
        )}
      </PanelCard>
      <ConfirmDialog
        testId="rechte-revoke-dialog"
        show={revokeTarget !== null}
        title={t('rechte_revoke_title')}
        message={
          revokeTarget?.access === 'account'
            ? t('rechte_revoke_account_message', {
                name: displayName(revokeTarget),
                scope: accountScopeLabel,
              })
            : t('rechte_revoke_message', {
                name: revokeTarget ? displayName(revokeTarget) : '',
              })
        }
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
