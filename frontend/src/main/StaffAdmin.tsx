import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Container,
  Form,
  Modal,
  Spinner,
} from 'react-bootstrap';
import {
  ArrowRepeat,
  Envelope,
  Incognito,
  Key,
  PencilSquare,
  PersonPlus,
  ShieldLock,
  ShieldX,
  Trash,
  XLg,
} from 'react-bootstrap-icons';
import DataTable from 'react-data-table-component';
import type { TableColumn } from 'react-data-table-component';
import { useSnackbar } from 'notistack';
import { Trans, useTranslation } from 'react-i18next';

import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import {
  errorReason,
  showErrorBar,
  showInfoBar,
  showRequestError,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import { formatDate } from './dateFormat';
import { startImpersonation } from './impersonation';
import StaffAccessRequests from './StaffAccessRequests';
import StaffMessaging from './StaffMessaging';
import StaffNotificationCases from './StaffNotificationCases';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import HoverDetails from '../components/ui/kit/HoverDetails';
import PasswordStrengthMeter, {
  evaluatePasswordStrength,
} from '../components/ui/PasswordStrengthMeter';
import { staffFlags, useAccess } from './access';
import { childTestId, repeatedTestId } from '../testIds';
import {
  applyPermissionPreset,
  copyPermissions,
  grantablePermissionGroups,
  selectedPermissionPreset,
} from './staffPermissions';
import {
  AccountBoxes,
  AccountLegend,
  accountLegend,
  AccountPicker,
  matchesAccountFilter,
  type UserAccount,
} from './staffAccounts';
import './StaffAdmin.css';
import { useMobileColumns } from '../components/ui/kit/mobileTable';

type PermissionDef = {
  code: string;
  label: string;
};

type StaffUser = {
  id: number;
  username: string;
  email: string;
  is_staff: boolean;
  is_superuser: boolean;
  is_active: boolean;
  date_joined?: string | null;
  last_login?: string | null;
  two_factor_enabled?: boolean;
  /** Holds a valid (unexpired, not logged out) refresh token somewhere. */
  logged_in?: boolean;
  /** Newest of those tokens: the last login or renewal (~hourly in an open tab). */
  last_activity?: string | null;
  permissions: Record<string, boolean>;
  grantable: Record<string, boolean>;
  /** The accounts the user is a member of - coloured boxes, see staffAccounts.tsx. */
  accounts?: UserAccount[];
  /** Objects reached by single access beyond those accounts (ProgeoAccess). */
  single_access?: number;
};

type UsersResponse = {
  users: StaffUser[];
  grantable_codes: string[];
  all_permission_defs: PermissionDef[];
  /** "staff": every user; "customer": a customer admin's - the customers of admin_accounts. */
  scope?: 'staff' | 'customer';
  admin_accounts?: UserAccount[];
  /** The accounts the admin may hand out / take away: staff all, a customer admin their own. */
  account_choices?: UserAccount[];
};

const EMPTY_RESPONSE: UsersResponse = {
  users: [],
  grantable_codes: [],
  all_permission_defs: [],
};

/** A plausible email address - a new user's login name. */
const isValidEmail = (input: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.trim());

/** Compact human-readable label for a permission code. */
const permissionLabel = (code: string): string => {
  const cleaned = code
    .replace(/^module_/, '')
    .replace(/_enabled$/, '')
    .replace(/_/g, ' ')
    .trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
};

const rowPermissions = (user: StaffUser): string[] =>
  Object.keys(user.permissions || {}).filter((code) => user.permissions[code]);

type Role = 'superuser' | 'staff' | 'user';

const roleOf = (user: StaffUser): Role =>
  user.is_superuser ? 'superuser' : user.is_staff ? 'staff' : 'user';

/** Sort order of the role column: users, staff, superusers. */
const ROLE_RANK: Record<Role, number> = { user: 0, staff: 1, superuser: 2 };

type Filters = {
  text: string;
  role: '' | Role;
  active: '' | 'active' | 'inactive';
  twoFactor: '' | 'on' | 'off';
  session: '' | 'in' | 'out';
  permission: string;
  /** '' = all, an account id, or NO_ACCOUNT (staffAccounts.tsx). */
  account: string;
};

const NO_FILTERS: Filters = {
  text: '',
  role: '',
  active: '',
  twoFactor: '',
  session: '',
  permission: '',
  account: '',
};

/** Small dot before the username: green while logged in, a grey ring if not. */
const SessionDot = ({ user }: { user: StaffUser }) => {
  const { t } = useTranslation();
  const title = user.logged_in
    ? t('staff_session_logged_in', { time: formatDate(user.last_activity) })
    : t('staff_session_logged_out');
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={`d-inline-block rounded-circle me-2 flex-shrink-0 staff-session-dot${user.logged_in ? ' staff-session-dot--on' : ''}`}
      {...repeatedTestId('staff-user-session', user.id)}
    />
  );
};

/** Mirrors the backend's DEFAULT_USER_PERMISSIONS (progeo/v1/models.py) -
 * preselected for a new user; the backend applies these regardless. */
const DEFAULT_NEW_USER_PERMISSIONS = [
  'module_navbar_enabled',
  'module_locations_enabled',
  'module_measurements_enabled',
  'module_notifications_enabled',
  'module_profile_mail_edit',
];

const UserFormModal = ({
  show,
  onHide,
  title,
  user,
  grantableCodes,
  permissionDefs,
  isNew,
  onSave,
  onGeneratePassword,
  staffFields = true,
  canInvite = true,
  canDisable = true,
  accountChoices = [],
  accountsLocked = null,
  customerAdmin = false,
  accountColorOf,
  users = [],
  testId,
}: {
  show: boolean;
  onHide: () => void;
  title: string;
  user: StaffUser | null;
  grantableCodes: string[];
  permissionDefs: PermissionDef[];
  isNew: boolean;
  onSave: (data: Record<string, unknown>) => void;
  onGeneratePassword?: (user: StaffUser) => void;
  /** The staff switch - not for customer admins, who manage customers only. */
  staffFields?: boolean;
  /** "Send invitation" (module_user_invitable). */
  canInvite?: boolean;
  /** The active switch (module_user_disability) - without it the flag stays as it is. */
  canDisable?: boolean;
  /** The accounts the editor may hand out (account_choices: staff all, a customer admin their own). */
  accountChoices?: UserAccount[];
  /** Why the accounts can't be changed here (another customer admin's) - null: they can. */
  accountsLocked?: string | null;
  /** The editor is a customer admin: a new user needs one of their accounts, a user
   * without any drops out of their list. */
  customerAdmin?: boolean;
  accountColorOf: (id: number) => string;
  /** The users whose permissions can be copied ("Berechtigungen übernehmen von"). */
  users?: StaffUser[];
  /** data-testid of the dialog; its fields and buttons are "<testId>-<name>". */
  testId: string;
}) => {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isStaff, setIsStaff] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [sendInvite, setSendInvite] = useState(false);
  const [selectedPerms, setSelectedPerms] = useState<string[]>([]);
  const [selectedAccounts, setSelectedAccounts] = useState<number[]>([]);
  // The user whose permissions were copied in - told until saved.
  const [copied, setCopied] = useState<{
    username: string;
    skipped: string[];
  } | null>(null);
  // Asked first (a ConfirmDialog inside this modal): a new password, or
  // saving with "active" switched off - the payload waits meanwhile.
  const [ask, setAsk] = useState<
    | { kind: 'password' }
    | { kind: 'deactivate'; payload: Record<string, unknown> }
    | null
  >(null);

  useEffect(() => {
    if (!show) {
      return;
    }
    setAsk(null);
    setCopied(null);
    setEmail(user?.email || '');
    setPassword('');
    setIsStaff(Boolean(user?.is_staff));
    setIsActive(user ? Boolean(user.is_active) : true);
    setSendInvite(false);
    // A customer admin's only account is preselected for a new user.
    setSelectedAccounts(
      user
        ? (user.accounts ?? []).map((account) => account.id)
        : customerAdmin && accountChoices.length === 1
          ? [accountChoices[0].id]
          : [],
    );
    setSelectedPerms(
      user
        ? rowPermissions(user)
        : DEFAULT_NEW_USER_PERMISSIONS.filter((code) =>
            grantableCodes.includes(code),
          ),
    );
    // Per opening - `accountChoices` is a new array with every load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, user, grantableCodes]);

  const togglePermission = (code: string) => {
    if (!grantableCodes.includes(code)) {
      return;
    }
    setSelectedPerms((current) =>
      current.includes(code)
        ? current.filter((item) => item !== code)
        : [...current, code],
    );
  };

  const handleSubmit = () => {
    const payload: Record<string, unknown> = {
      email,
      is_active: isActive,
      permissions: selectedPerms,
    };
    if (staffFields) {
      payload.is_staff = isStaff;
    }
    // The wanted accounts (within the editor's choices) - not where they can't be changed.
    if (!accountsLocked) {
      payload.accounts = selectedAccounts;
    }
    // A new user's login name is their email address (the server derives it).
    if (isNew) {
      if (password) {
        payload.password = password;
      }
      payload.send_invite = sendInvite;
    }
    if (!isNew && canDisable && user?.is_active && !isActive) {
      setAsk({ kind: 'deactivate', payload });
      return;
    }
    onSave(payload);
  };

  // Everyone but the edited user, by name.
  const copySources = users
    .filter((other) => other.id !== user?.id)
    .sort((a, b) => a.username.localeCompare(b.username));
  const copyFrom = (sourceId: string) => {
    const source = copySources.find((other) => String(other.id) === sourceId);
    if (!source) {
      return;
    }
    const result = copyPermissions(
      selectedPerms,
      rowPermissions(source),
      grantableCodes,
    );
    setSelectedPerms(result.permissions);
    setCopied({ username: source.username, skipped: result.skipped });
  };
  const labelOf = (code: string) =>
    permissionDefs.find((def) => def.code === code)?.label ??
    permissionLabel(code);

  // None of the editor's accounts picked: a customer admin's new user would be
  // invisible to them, an existing one drops out of their list.
  const noAccount = !accountChoices.some((account) =>
    selectedAccounts.includes(account.id),
  );

  // Only what the editor may grant is shown - a group without any is left out.
  const {
    shown: grantableDefs,
    groups: groupedPermissionDefs,
    ungrouped: ungroupedDefinitions,
  } = grantablePermissionGroups(permissionDefs, grantableCodes);

  return (
    <Modal show={show} onHide={onHide} centered size="xl" data-testid={testId}>
      <Modal.Header closeButton>
        <Modal.Title>{title}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Form>
          <Form.Group className="mb-3">
            <Form.Label>{t('staff_field_email')}</Form.Label>
            <Form.Control
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="email"
              data-testid={childTestId(testId, 'email')}
            />
          </Form.Group>
          {isNew && (
            <Form.Group className="mb-3">
              <Form.Label>{t('staff_field_password')}</Form.Label>
              <Form.Control
                type="text"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t('staff_field_password_placeholder')}
                data-testid={childTestId(testId, 'password')}
              />
              {/* Empty: the server generates one - typed: it has to be a good one. */}
              {password && (
                <div className="mt-2">
                  <PasswordStrengthMeter
                    password={password}
                    testId={childTestId(testId, 'password')}
                  />
                </div>
              )}
            </Form.Group>
          )}

          {accountChoices.length > 0 && (
            <Form.Group className="mb-3">
              <Form.Label>
                {t('staff_field_accounts')}{' '}
                <small className="text-muted">
                  {t('staff_field_accounts_hint')}
                </small>
              </Form.Label>
              <AccountPicker
                choices={accountChoices}
                selected={selectedAccounts}
                onChange={setSelectedAccounts}
                locked={accountsLocked}
                colorOf={accountColorOf}
                testId={`${testId}-accounts`}
              />
              {customerAdmin && !accountsLocked && noAccount && (
                <small
                  className="text-danger d-block mt-1"
                  data-testid={childTestId(testId, 'accounts-none')}
                >
                  {isNew
                    ? t('staff_accounts_required')
                    : t('staff_accounts_leave_hint')}
                </small>
              )}
            </Form.Group>
          )}

          <div className="staff-user-switches mb-3">
            {staffFields && (
              <Form.Check
                type="switch"
                id="staff-switch"
                label={t('staff_field_is_staff')}
                checked={isStaff}
                onChange={(event) => setIsStaff(event.target.checked)}
                data-testid={childTestId(testId, 'is-staff')}
              />
            )}
            {canDisable && (
              <Form.Check
                type="switch"
                id="active-switch"
                label={t('staff_field_is_active')}
                checked={isActive}
                onChange={(event) => setIsActive(event.target.checked)}
                data-testid={childTestId(testId, 'is-active')}
              />
            )}
            {isNew && canInvite && (
              <Form.Check
                type="switch"
                id="invite-switch"
                label={t('staff_field_send_invite')}
                title={t('staff_field_send_invite_hint')}
                checked={sendInvite}
                disabled={!email}
                onChange={(event) => setSendInvite(event.target.checked)}
                data-testid={childTestId(testId, 'send-invite')}
              />
            )}
          </div>

          <div className="d-flex flex-wrap align-items-end justify-content-between gap-2 mb-1">
            <Form.Label className="mb-0">
              {t('staff_field_permissions')}{' '}
              <small className="text-muted">
                {t('staff_field_permissions_hint')}
              </small>
            </Form.Label>
            {copySources.length > 0 && grantableCodes.length > 0 && (
              <Form.Select
                size="sm"
                className="staff-permission-copy"
                aria-label={t('staff_permission_copy_from')}
                // Always back to the prompt: picking the same user again copies again.
                value=""
                onChange={(event) => copyFrom(event.target.value)}
                data-testid={childTestId(testId, 'permission-copy')}
              >
                <option value="">{t('staff_permission_copy_from')}</option>
                {copySources.map((other) => (
                  <option key={other.id} value={other.id}>
                    {t('staff_permission_copy_option', {
                      username: other.username,
                      count: rowPermissions(other).length,
                    })}
                  </option>
                ))}
              </Form.Select>
            )}
          </div>
          {copied && (
            <div
              className="small text-muted mb-2"
              data-testid={childTestId(testId, 'permission-copied')}
            >
              {t('staff_permission_copied', { username: copied.username })}
              {copied.skipped.length > 0 &&
                ` ${t('staff_permission_copy_skipped', {
                  codes: copied.skipped.map(labelOf).join(', '),
                })}`}
            </div>
          )}
          {grantableDefs.length > 0 && (
            <div
              className="staff-permissions-box mb-2"
              data-testid={childTestId(testId, 'permissions')}
            >
              <div className="row g-2">
                {groupedPermissionDefs.map((group) => {
                  const selectedLabels = group.definitions
                    .filter((def) => selectedPerms.includes(def.code))
                    .map((def) => def.label);
                  const preset = selectedPermissionPreset(
                    selectedPerms,
                    group,
                    grantableCodes,
                  );
                  return (
                    <div className="col-12 col-md-6" key={group.id}>
                      <section
                        className={`staff-permission-group staff-permission-group--${group.id}`}
                        data-testid={childTestId(
                          testId,
                          `permission-group-${group.id}`,
                        )}
                      >
                        <div className="d-flex align-items-center justify-content-between gap-2">
                          <strong>{t(group.labelKey)}</strong>
                          <Form.Select
                            size="sm"
                            aria-label={t('staff_permission_preset_label', {
                              group: t(group.labelKey),
                            })}
                            value={preset}
                            onChange={(event) =>
                              setSelectedPerms((current) =>
                                applyPermissionPreset(
                                  current,
                                  group,
                                  event.target.value,
                                  grantableCodes,
                                ),
                              )
                            }
                            data-testid={childTestId(
                              testId,
                              `permission-preset-${group.id}`,
                            )}
                          >
                            {preset === 'custom' && (
                              <option value="custom">
                                {t('staff_permission_custom')}
                              </option>
                            )}
                            {Object.keys(group.presets).map((presetKey) => (
                              <option key={presetKey} value={presetKey}>
                                {t(`staff_permission_preset_${presetKey}`)}
                              </option>
                            ))}
                          </Form.Select>
                        </div>
                        <div
                          className="staff-permission-summary"
                          title={selectedLabels.join(', ')}
                        >
                          {selectedLabels.length
                            ? selectedLabels.join(', ')
                            : t('staff_permissions_none')}
                        </div>
                        <HoverDetails
                          className="staff-permission-details"
                          summary={t('staff_permission_customize')}
                          testId={childTestId(
                            testId,
                            `permission-details-${group.id}`,
                          )}
                        >
                          <div className="staff-permission-options">
                            {group.definitions.map((def) => (
                              <Form.Check
                                key={def.code}
                                type="checkbox"
                                id={`perm-${def.code}`}
                                label={def.label}
                                checked={selectedPerms.includes(def.code)}
                                onChange={() => togglePermission(def.code)}
                                {...repeatedTestId(
                                  `${testId}-permission`,
                                  def.code,
                                )}
                              />
                            ))}
                          </div>
                        </HoverDetails>
                      </section>
                    </div>
                  );
                })}
                {ungroupedDefinitions.length > 0 && (
                  <div className="col-12 col-md-6">
                    <section className="staff-permission-group staff-permission-group--other">
                      <strong>{t('staff_permission_group_other')}</strong>
                      <div className="staff-permission-options">
                        {ungroupedDefinitions.map((def) => (
                          <Form.Check
                            key={def.code}
                            type="checkbox"
                            id={`perm-${def.code}`}
                            label={def.label}
                            checked={selectedPerms.includes(def.code)}
                            onChange={() => togglePermission(def.code)}
                            {...repeatedTestId(
                              `${testId}-permission`,
                              def.code,
                            )}
                          />
                        ))}
                      </div>
                    </section>
                  </div>
                )}
              </div>
            </div>
          )}
          {grantableDefs.length === 0 && (
            <small className="text-muted">
              {t('staff_no_grantable_permissions')}
            </small>
          )}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        {!isNew && onGeneratePassword && user && (
          <>
            <small className="text-muted me-auto staff-invite-hint">
              {t('staff_password_invite_hint')}
            </small>
            <Button
              variant="outline-warning"
              onClick={() => setAsk({ kind: 'password' })}
              data-testid={childTestId(testId, 'generate-password')}
            >
              <Key className="me-1" />
              {t('staff_generate_password')}
            </Button>
          </>
        )}
        <Button
          variant="secondary"
          onClick={onHide}
          data-testid={childTestId(testId, 'cancel')}
        >
          {t('staff_cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={
            isNew &&
            (!isValidEmail(email) ||
              (password !== '' && !evaluatePasswordStrength(password).valid) ||
              (customerAdmin && noAccount))
          }
          data-testid={childTestId(testId, 'save')}
        >
          {t('staff_save')}
        </Button>
      </Modal.Footer>
      {/* Inside the modal: above it, and its focus trap leaves the buttons usable. */}
      <ConfirmDialog
        show={ask !== null && user !== null}
        title={
          ask?.kind === 'deactivate'
            ? t('staff_deactivate_confirm_title')
            : t('staff_password_confirm_title')
        }
        message={
          ask?.kind === 'deactivate'
            ? t('staff_deactivate_confirm_body', {
                username: user?.username ?? '',
              })
            : t('staff_password_confirm_body', {
                username: user?.username ?? '',
              })
        }
        confirmLabel={
          ask?.kind === 'deactivate'
            ? t('staff_deactivate_confirm_yes')
            : t('staff_password_confirm_yes')
        }
        cancelLabel={t('staff_cancel')}
        onConfirm={() => {
          if (ask?.kind === 'deactivate') {
            onSave(ask.payload);
          } else if (ask?.kind === 'password' && user && onGeneratePassword) {
            onGeneratePassword(user);
          }
          setAsk(null);
        }}
        onCancel={() => setAsk(null)}
        testId={
          ask?.kind === 'deactivate'
            ? 'staff-user-deactivate-dialog'
            : 'staff-user-password-dialog'
        }
      />
    </Modal>
  );
};

/** The row actions that ask first - their ConfirmDialog ("staff-user-<action>-dialog"). */
type UserAction =
  'password' | 'invite' | 'reset-two-factor' | 'impersonate' | 'delete';
const USER_ACTIONS: Record<
  UserAction,
  { title: string; message: string; confirm: string; danger: boolean }
> = {
  password: {
    title: 'staff_password_confirm_title',
    message: 'staff_password_confirm_body',
    confirm: 'staff_password_confirm_yes',
    danger: true,
  },
  invite: {
    title: 'staff_invite_confirm_title',
    message: 'staff_invite_confirm',
    confirm: 'staff_send_invite',
    danger: false,
  },
  'reset-two-factor': {
    title: 'staff_reset_two_factor_confirm_title',
    message: 'staff_reset_two_factor_confirm',
    confirm: 'staff_reset_two_factor',
    danger: true,
  },
  impersonate: {
    title: 'staff_impersonate_confirm_title',
    message: 'staff_impersonate_confirm',
    confirm: 'staff_impersonate',
    danger: false,
  },
  delete: {
    title: 'staff_delete_confirm_title',
    message: 'staff_delete_confirm',
    confirm: 'staff_delete_user',
    danger: true,
  },
};

const PasswordResultModal = ({
  show,
  onHide,
  username,
  password,
}: {
  show: boolean;
  onHide: () => void;
  username: string;
  password: string;
}) => {
  const { t } = useTranslation();
  return (
    <Modal
      show={show}
      onHide={onHide}
      centered
      data-testid="staff-password-result"
    >
      <Modal.Header closeButton>
        <Modal.Title>{t('staff_password_result_title')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p>
          <Trans
            i18nKey="staff_password_result_text"
            values={{ username }}
            components={{ strong: <strong /> }}
          />
        </p>
        <Form.Control
          readOnly
          value={password}
          onFocus={(event) => event.target.select()}
          data-testid="staff-password-result-value"
        />
        <Form.Text muted>{t('staff_password_invite_hint')}</Form.Text>
      </Modal.Body>
      <Modal.Footer>
        <Button
          variant="primary"
          onClick={onHide}
          data-testid="staff-password-result-close"
        >
          {t('staff_close')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

const StaffAdmin = () => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();

  const [response, setResponse] = useState<UsersResponse>(EMPTY_RESPONSE);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [editUser, setEditUser] = useState<StaffUser | null>(null);
  const [passwordResult, setPasswordResult] = useState<{
    username: string;
    password: string;
  } | null>(null);
  // A row action waiting for its ConfirmDialog (USER_ACTIONS).
  const [pending, setPending] = useState<{
    kind: UserAction;
    user: StaffUser;
  } | null>(null);

  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  // Toggled with every filter change: a shorter list may have fewer pages
  // than the one shown - back to page 1.
  const [resetPage, setResetPage] = useState(false);
  const updateFilters = (next: Filters) => {
    setFilters(next);
    setResetPage((current) => !current);
  };
  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    updateFilters({ ...filters, [key]: value });
  const filtersActive = Object.values(filters).some(Boolean);

  const authUser = auth?.user as { user_id?: number | string } | null;
  // Staff or superuser, like the route (access.ts) and the backend.
  const { isStaffOrSuperuser: isStaff, isSuperuser } = staffFlags(auth?.user);
  // Customer admins (module_customer_admin_enabled, no staff): the users of their
  // own account - only this table, only what the backend lets them do.
  const { hasPermission } = useAccess();
  const isCustomerAdmin =
    !isStaff && hasPermission('module_customer_admin_enabled');
  const canManageUsers = isStaff || isCustomerAdmin;
  // The user actions, each with its own permission (backend: holds_permission).
  const canAddUser = hasPermission('module_user_add');
  const canInviteUser = hasPermission('module_user_invitable');
  const canDisableUser = hasPermission('module_user_disability');
  const canDeleteUser = hasPermission('module_user_erasability');

  const fetchUsers = useCallback(() => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      '/api/auth-support/staff/users/',
      (result) => {
        setResponse((result?.data || EMPTY_RESPONSE) as UsersResponse);
        setLoading(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('staff_load_error'), error);
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar, t]);

  useEffect(() => {
    if (canManageUsers) {
      fetchUsers();
    } else {
      setLoading(false);
    }
  }, [canManageUsers, fetchUsers]);

  const handleSave =
    (user: StaffUser | null, isNew: boolean) =>
    (data: Record<string, unknown>) => {
      setBusyId(isNew ? -1 : (user?.id ?? -1));
      const url = isNew
        ? '/api/auth-support/staff/users/'
        : `/api/auth-support/staff/users/${user!.id}/update/`;
      void axiosConfig.perform_post(
        auth,
        url,
        data,
        (result) => {
          const denied = (result?.data?.denied_permissions || []) as string[];
          const generated = (result?.data?.generated_password || null) as
            string | null;
          if (denied.length > 0) {
            showInfoBar(
              enqueueSnackbar,
              t('staff_denied_permissions', { codes: denied.join(', ') }),
            );
          }
          if (result?.data?.invite_sent) {
            showInfoBar(enqueueSnackbar, t('staff_invite_sent'));
          }
          if (generated) {
            setPasswordResult({
              username: (result?.data?.user?.username as string) || '',
              password: generated,
            });
          }
          showSuccessBar(
            enqueueSnackbar,
            isNew ? t('staff_user_created') : t('staff_user_updated'),
          );
          setShowCreate(false);
          setEditUser(null);
          setBusyId(null);
          fetchUsers();
        },
        (error) => {
          const reason = errorReason(error);
          showErrorBar(
            enqueueSnackbar,
            isNew
              ? t('staff_create_error', { reason })
              : t('staff_update_error', { reason }),
          );
          setBusyId(null);
        },
      );
    };

  const handleGeneratePassword = (user: StaffUser) => {
    setBusyId(user.id);
    void axiosConfig.perform_post(
      auth,
      `/api/auth-support/staff/users/${user.id}/password/`,
      {},
      (result) => {
        setPasswordResult({
          username: result?.data?.username || user.username,
          password: result?.data?.new_password || '',
        });
        setBusyId(null);
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('staff_password_error'), error);
        setBusyId(null);
      },
    );
  };

  const handleInvite = (user: StaffUser) => {
    setBusyId(user.id);
    void axiosConfig.perform_post(
      auth,
      `/api/auth-support/staff/users/${user.id}/invite/`,
      {},
      () => {
        showSuccessBar(enqueueSnackbar, t('staff_invite_sent'));
        setBusyId(null);
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('staff_invite_error'), error);
        setBusyId(null);
      },
    );
  };

  // Lost phone: the user sets up 2FA again; all their logins end.
  const handleResetTwoFactor = (user: StaffUser) => {
    setBusyId(user.id);
    void axiosConfig.perform_post(
      auth,
      `/api/auth-support/staff/users/${user.id}/update/`,
      { reset_two_factor: true },
      () => {
        showSuccessBar(
          enqueueSnackbar,
          t('staff_reset_two_factor_done', { username: user.username }),
        );
        setBusyId(null);
        fetchUsers();
      },
      (error) => {
        showRequestError(
          enqueueSnackbar,
          t('staff_reset_two_factor_error'),
          error,
        );
        setBusyId(null);
      },
    );
  };

  // Superusers only: see the portal as this user (no password, no 2FA).
  const handleImpersonate = (user: StaffUser) => {
    setBusyId(user.id);
    void axiosConfig.perform_post(
      auth,
      `/api/auth-support/staff/users/${user.id}/impersonate/`,
      {},
      (result) => {
        setBusyId(null);
        startImpersonation(auth, result?.data?.access as string);
        auth.navigate('/');
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('staff_impersonate_error'), error);
        setBusyId(null);
      },
    );
  };

  const canImpersonate = (user: StaffUser) =>
    isSuperuser &&
    !user.is_superuser &&
    user.is_active &&
    String(user.id) !== String(authUser?.user_id);

  const roleLabel = useCallback(
    (role: Role) =>
      role === 'superuser'
        ? t('staff_badge_superuser')
        : role === 'staff'
          ? t('staff_badge_staff')
          : t('staff_badge_user'),
    [t],
  );

  const filteredUsers = useMemo(() => {
    const needle = filters.text.trim().toLowerCase();
    return response.users.filter((user) => {
      if (filters.role && roleOf(user) !== filters.role) {
        return false;
      }
      if (filters.active && user.is_active !== (filters.active === 'active')) {
        return false;
      }
      if (
        filters.twoFactor &&
        Boolean(user.two_factor_enabled) !== (filters.twoFactor === 'on')
      ) {
        return false;
      }
      if (
        filters.session &&
        Boolean(user.logged_in) !== (filters.session === 'in')
      ) {
        return false;
      }
      if (filters.permission && !user.permissions?.[filters.permission]) {
        return false;
      }
      if (!matchesAccountFilter(user, filters.account)) {
        return false;
      }
      if (!needle) {
        return true;
      }
      const permissions = rowPermissions(user);
      const haystack = [
        String(user.id),
        user.username,
        user.email,
        roleLabel(roleOf(user)),
        user.is_active ? t('staff_badge_active') : t('staff_badge_inactive'),
        user.two_factor_enabled ? t('staff_badge_two_factor') : '',
        user.logged_in ? t('staff_filter_logged_in') : '',
        ...permissions,
        ...permissions.map(
          (code) =>
            response.all_permission_defs.find((def) => def.code === code)
              ?.label ?? permissionLabel(code),
        ),
        ...(user.accounts ?? []).map((account) => account.name),
        user.date_joined ? formatDate(user.date_joined) : '',
        user.last_login ? formatDate(user.last_login) : '',
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [response.users, response.all_permission_defs, filters, roleLabel, t]);

  const handleDelete = (user: StaffUser) => {
    setBusyId(user.id);
    void axiosConfig.perform_post(
      auth,
      `/api/auth-support/staff/users/${user.id}/delete/`,
      {},
      (result) => {
        showSuccessBar(
          enqueueSnackbar,
          t('staff_user_deleted', {
            username: result?.data?.deleted || user.username,
          }),
        );
        setBusyId(null);
        fetchUsers();
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('staff_delete_error'), error);
        setBusyId(null);
      },
    );
  };

  // Colours of the accounts: by name over all users, so a filter keeps them.
  const legend = useMemo(() => accountLegend(response.users), [response.users]);
  const withoutAccount = useMemo(
    () => response.users.filter((user) => !user.accounts?.length).length,
    [response.users],
  );
  const accountColorOf = useMemo(() => {
    const colors = new Map(legend.map((entry) => [entry.id, entry.color]));
    return (id: number) => colors.get(id) ?? '#b8b0b0';
  }, [legend]);

  const allColumns = useMemo<TableColumn<StaffUser>[]>(
    () =>
      [
        {
          // The email address is the login name - no column of its own for
          // the username. Older users without an address show it, muted.
          id: 'email',
          name: t('staff_col_email'),
          selector: (row) => (row.email || row.username).toLowerCase(),
          sortable: true,
          cell: (row) => (
            <span
              className="d-inline-flex align-items-center"
              {...repeatedTestId('staff-user-email', row.id)}
            >
              <SessionDot user={row} />
              {row.email ? (
                row.email
              ) : (
                <span
                  className="text-muted"
                  title={t('staff_user_without_email')}
                >
                  {row.username}
                </span>
              )}
              {row.is_superuser && (
                <ShieldLock className="ms-2 text-warning" size={14} />
              )}
            </span>
          ),
        },
        {
          id: 'accounts',
          name: t('staff_col_accounts'),
          // By the number of accounts, then single access, then the first account's name.
          selector: (row) =>
            `${String(row.accounts?.length ?? 0).padStart(4, '0')} ${String(row.single_access ?? 0).padStart(6, '0')} ${(row.accounts?.[0]?.name ?? '').toLowerCase()}`,
          sortable: true,
          cell: (row) => (
            <AccountBoxes
              userId={row.id}
              accounts={row.accounts ?? []}
              singleAccess={row.single_access ?? 0}
              colorOf={accountColorOf}
            />
          ),
          minWidth: '140px',
        },
        {
          id: 'role',
          name: t('staff_col_staff'),
          selector: (row) => ROLE_RANK[roleOf(row)],
          sortable: true,
          cell: (row) => {
            const role = roleOf(row);
            return (
              <Badge
                bg={role === 'user' ? 'secondary' : 'warning'}
                text={role === 'user' ? undefined : 'dark'}
                {...repeatedTestId('staff-user-role', row.id)}
              >
                {roleLabel(role)}
              </Badge>
            );
          },
          width: '120px',
        },
        {
          name: t('staff_col_active'),
          selector: (row) => Number(row.is_active),
          sortable: true,
          cell: (row) =>
            row.is_active ? (
              <Badge
                bg="success"
                {...repeatedTestId('staff-user-active', row.id)}
              >
                {t('staff_badge_active')}
              </Badge>
            ) : (
              <Badge
                bg="danger"
                {...repeatedTestId('staff-user-active', row.id)}
              >
                {t('staff_badge_inactive')}
              </Badge>
            ),
          width: '100px',
        },
        {
          name: t('staff_col_two_factor'),
          selector: (row) => Number(Boolean(row.two_factor_enabled)),
          sortable: true,
          cell: (row) =>
            row.two_factor_enabled ? (
              <Badge
                bg="success"
                {...repeatedTestId('staff-user-two-factor', row.id)}
              >
                {t('staff_badge_two_factor')}
              </Badge>
            ) : (
              <span className="text-muted small">-</span>
            ),
          width: '80px',
        },
        {
          name: t('staff_col_permissions'),
          selector: (row) => rowPermissions(row).length,
          sortable: true,
          cell: (row) => {
            const enabled = rowPermissions(row);
            if (enabled.length === 0) {
              return (
                <span
                  className="text-muted small"
                  {...repeatedTestId('staff-user-permissions', row.id)}
                >
                  {t('staff_permissions_none')}
                </span>
              );
            }
            return (
              <span
                className="d-flex flex-wrap gap-1"
                {...repeatedTestId('staff-user-permissions', row.id)}
              >
                {enabled.slice(0, 3).map((code) => (
                  <Badge key={code} bg="info" pill text="dark">
                    {response.all_permission_defs.find(
                      (def) => def.code === code,
                    )?.label ?? permissionLabel(code)}
                  </Badge>
                ))}
                {enabled.length > 3 && (
                  <Badge bg="secondary" pill>
                    +{enabled.length - 3}
                  </Badge>
                )}
              </span>
            );
          },
        },
        {
          name: t('staff_col_date_joined'),
          selector: (row) => row.date_joined || '',
          format: (row) => formatDate(row.date_joined, 'date'),
          sortable: true,
          width: '120px',
        },
        {
          name: t('staff_col_last_login'),
          selector: (row) => row.last_login || '',
          format: (row) => formatDate(row.last_login),
          sortable: true,
          width: '150px',
        },
        {
          name: t('staff_col_actions'),
          width: '300px',
          cell: (row) => (
            <span className="d-flex gap-1">
              <Button
                size="sm"
                variant="outline-primary"
                title={t('staff_edit_user')}
                aria-label={t('staff_edit_user')}
                disabled={busyId === row.id}
                onClick={() => setEditUser(row)}
                {...repeatedTestId('staff-user-edit', row.id)}
              >
                <PencilSquare size={14} />
              </Button>
              {isStaff && (
                <Button
                  size="sm"
                  variant="outline-warning"
                  title={`${t('staff_generate_new_password')} - ${t('staff_password_invite_hint')}`}
                  aria-label={`${t('staff_generate_new_password')} - ${t('staff_password_invite_hint')}`}
                  disabled={busyId === row.id}
                  onClick={() => setPending({ kind: 'password', user: row })}
                  {...repeatedTestId('staff-user-generate-password', row.id)}
                >
                  <Key size={14} />
                </Button>
              )}
              {canInviteUser && (
                <Button
                  size="sm"
                  variant="outline-secondary"
                  title={
                    row.email
                      ? t('staff_send_invite')
                      : t('staff_send_invite_no_email')
                  }
                  aria-label={
                    row.email
                      ? t('staff_send_invite')
                      : t('staff_send_invite_no_email')
                  }
                  disabled={busyId === row.id || !row.email || !row.is_active}
                  onClick={() => setPending({ kind: 'invite', user: row })}
                  {...repeatedTestId('staff-user-invite', row.id)}
                >
                  <Envelope size={14} />
                </Button>
              )}
              {isStaff && row.two_factor_enabled && (
                <Button
                  size="sm"
                  variant="outline-secondary"
                  title={t('staff_reset_two_factor')}
                  aria-label={t('staff_reset_two_factor')}
                  disabled={busyId === row.id}
                  onClick={() =>
                    setPending({ kind: 'reset-two-factor', user: row })
                  }
                  {...repeatedTestId('staff-user-reset-two-factor', row.id)}
                >
                  <ShieldX size={14} />
                </Button>
              )}
              {canImpersonate(row) && (
                <Button
                  size="sm"
                  variant="outline-dark"
                  title={t('staff_impersonate')}
                  aria-label={t('staff_impersonate')}
                  disabled={busyId === row.id}
                  onClick={() => setPending({ kind: 'impersonate', user: row })}
                  {...repeatedTestId('staff-user-impersonate', row.id)}
                >
                  <Incognito size={14} />
                </Button>
              )}
              {isStaff && canDeleteUser && (
                <Button
                  size="sm"
                  variant="outline-danger"
                  title={t('staff_delete_user')}
                  aria-label={t('staff_delete_user')}
                  disabled={busyId === row.id}
                  onClick={() => setPending({ kind: 'delete', user: row })}
                  {...repeatedTestId('staff-user-delete', row.id)}
                >
                  <Trash size={14} />
                </Button>
              )}
            </span>
          ),
        },
      ]
        // Customer admins list customers only - the role column tells them nothing.
        .filter((column) => !(isCustomerAdmin && column.id === 'role')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      busyId,
      t,
      roleLabel,
      isSuperuser,
      isStaff,
      isCustomerAdmin,
      accountColorOf,
      response.all_permission_defs,
      canInviteUser,
      canDeleteUser,
    ],
  );
  // Phones: the address in the row, everything else (the actions too) in its expander.
  const { columns, expandable } = useMobileColumns(allColumns, ['email']);

  if (!canManageUsers) {
    return (
      <Container data-testid="page-staff">
        <Card
          className="border-0 shadow-sm my-5"
          data-testid="staff-access-required"
        >
          <Card.Body className="text-center py-5">
            <ShieldLock size={40} className="text-muted mb-3" />
            <h5>{t('staff_access_required')}</h5>
            <p className="text-muted mb-0">{t('staff_access_required_hint')}</p>
          </Card.Body>
        </Card>
      </Container>
    );
  }

  return (
    <Container fluid data-testid="page-staff">
      <Card className="border-0 shadow-sm my-4 p-3" data-testid="staff-users">
        <Card.Body>
          <div className="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
            <h5 className="mb-0">
              <ShieldLock className="me-2 text-warning" />
              {isCustomerAdmin ? t('staff_title_customer') : t('staff_title')}
            </h5>
            <div className="d-flex gap-2">
              <Button
                variant="outline-secondary"
                size="sm"
                onClick={fetchUsers}
                data-testid="staff-users-refresh"
              >
                <ArrowRepeat className="me-1" />
                {t('staff_refresh')}
              </Button>
              {canAddUser && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setShowCreate(true)}
                  data-testid="staff-users-add"
                >
                  <PersonPlus className="me-1" />
                  {t('staff_add_user')}
                </Button>
              )}
            </div>
          </div>

          <div
            className="d-flex flex-wrap align-items-center gap-2 mb-2"
            data-testid="staff-users-filters"
          >
            <Form.Control
              size="sm"
              className="staff-filter-text"
              placeholder={t('staff_filter_text')}
              aria-label={t('staff_filter_text')}
              value={filters.text}
              onChange={(event) => setFilter('text', event.target.value)}
              data-testid="staff-users-filter-text"
            />
            {/* Customer admins list customers only - no roles or permissions to filter by. */}
            {!isCustomerAdmin && (
              <Form.Select
                size="sm"
                className="staff-filter-select"
                aria-label={t('staff_col_staff')}
                value={filters.role}
                onChange={(event) =>
                  setFilter('role', event.target.value as Filters['role'])
                }
                data-testid="staff-users-filter-role"
              >
                <option value="">{t('staff_filter_all_roles')}</option>
                <option value="superuser">{t('staff_badge_superuser')}</option>
                <option value="staff">{t('staff_badge_staff')}</option>
                <option value="user">{t('staff_badge_user')}</option>
              </Form.Select>
            )}
            <Form.Select
              size="sm"
              className="staff-filter-select"
              aria-label={t('staff_col_active')}
              value={filters.active}
              onChange={(event) =>
                setFilter('active', event.target.value as Filters['active'])
              }
              data-testid="staff-users-filter-active"
            >
              <option value="">{t('staff_filter_all_states')}</option>
              <option value="active">{t('staff_badge_active')}</option>
              <option value="inactive">{t('staff_badge_inactive')}</option>
            </Form.Select>
            <Form.Select
              size="sm"
              className="staff-filter-select"
              aria-label={t('staff_col_two_factor')}
              value={filters.twoFactor}
              onChange={(event) =>
                setFilter(
                  'twoFactor',
                  event.target.value as Filters['twoFactor'],
                )
              }
              data-testid="staff-users-filter-two-factor"
            >
              <option value="">{t('staff_filter_two_factor_any')}</option>
              <option value="on">{t('staff_filter_two_factor_on')}</option>
              <option value="off">{t('staff_filter_two_factor_off')}</option>
            </Form.Select>
            <Form.Select
              size="sm"
              className="staff-filter-select"
              aria-label={t('staff_col_session')}
              value={filters.session}
              onChange={(event) =>
                setFilter('session', event.target.value as Filters['session'])
              }
              data-testid="staff-users-filter-session"
            >
              <option value="">{t('staff_filter_session_any')}</option>
              <option value="in">{t('staff_filter_logged_in')}</option>
              <option value="out">{t('staff_filter_logged_out')}</option>
            </Form.Select>
            {!isCustomerAdmin && (
              <Form.Select
                size="sm"
                className="staff-filter-select staff-filter-select--narrow"
                aria-label={t('staff_col_permissions')}
                value={filters.permission}
                onChange={(event) =>
                  setFilter('permission', event.target.value)
                }
                data-testid="staff-users-filter-permission"
              >
                <option value="">{t('staff_filter_all_permissions')}</option>
                {response.all_permission_defs.map((def) => (
                  <option key={def.code} value={def.code}>
                    {def.label}
                  </option>
                ))}
              </Form.Select>
            )}
            {filtersActive && (
              <Button
                size="sm"
                variant="outline-secondary"
                onClick={() => updateFilters(NO_FILTERS)}
                data-testid="staff-users-filter-clear"
              >
                <XLg className="me-1" />
                {t('staff_filter_clear')}
              </Button>
            )}
            <small
              className="text-muted ms-auto"
              data-testid="staff-users-count"
            >
              {t('staff_filter_count', {
                shown: filteredUsers.length,
                total: response.users.length,
              })}
            </small>
          </div>

          <AccountLegend
            entries={legend}
            withoutAccount={withoutAccount}
            selected={filters.account}
            onSelect={(value) => setFilter('account', value)}
          />

          <DataTable
            columns={columns}
            {...expandable}
            data={filteredUsers}
            defaultSortFieldId="email"
            pagination
            paginationResetDefaultPage={resetPage}
            paginationPerPage={15}
            paginationRowsPerPageOptions={[10, 15, 25, 50]}
            progressPending={loading}
            progressComponent={
              <div
                className="d-flex align-items-center gap-2 text-muted py-4"
                data-testid="staff-users-loading"
              >
                <Spinner size="sm" animation="border" />
                {t('staff_loading')}
              </div>
            }
            highlightOnHover
            pointerOnHover
            dense
          />
        </Card.Body>
      </Card>

      {isStaff && <StaffAccessRequests onChanged={fetchUsers} />}

      {isStaff && <StaffMessaging />}

      {isStaff && <StaffNotificationCases />}

      <UserFormModal
        show={showCreate}
        onHide={() => setShowCreate(false)}
        title={t('staff_add_user')}
        user={null}
        isNew
        grantableCodes={response.grantable_codes}
        permissionDefs={response.all_permission_defs}
        onSave={handleSave(null, true)}
        staffFields={isStaff}
        canInvite={canInviteUser}
        canDisable={canDisableUser}
        accountChoices={response.account_choices ?? []}
        customerAdmin={isCustomerAdmin}
        accountColorOf={accountColorOf}
        users={response.users}
        testId="staff-user-create"
      />

      <UserFormModal
        show={editUser != null}
        onHide={() => setEditUser(null)}
        title={t('staff_edit_user_title', {
          username: editUser?.username || '',
        })}
        user={editUser}
        isNew={false}
        grantableCodes={response.grantable_codes}
        permissionDefs={response.all_permission_defs}
        onSave={handleSave(editUser, false)}
        onGeneratePassword={isStaff ? handleGeneratePassword : undefined}
        staffFields={isStaff}
        canDisable={canDisableUser}
        accountChoices={response.account_choices ?? []}
        // Another customer admin's accounts only staff change (helper/account_members.py).
        accountsLocked={
          isCustomerAdmin &&
          editUser?.permissions?.module_customer_admin_enabled
            ? t('staff_accounts_locked')
            : null
        }
        customerAdmin={isCustomerAdmin}
        accountColorOf={accountColorOf}
        users={response.users}
        testId="staff-user-edit-dialog"
      />

      <ConfirmDialog
        show={pending !== null}
        title={pending ? t(USER_ACTIONS[pending.kind].title) : ''}
        message={
          pending
            ? t(USER_ACTIONS[pending.kind].message, {
                username: pending.user.username,
                email: pending.user.email || '-',
              })
            : ''
        }
        confirmLabel={pending ? t(USER_ACTIONS[pending.kind].confirm) : ''}
        cancelLabel={t('staff_cancel')}
        danger={pending ? USER_ACTIONS[pending.kind].danger : true}
        onConfirm={() => {
          if (pending) {
            const run = {
              password: handleGeneratePassword,
              invite: handleInvite,
              'reset-two-factor': handleResetTwoFactor,
              impersonate: handleImpersonate,
              delete: handleDelete,
            }[pending.kind];
            run(pending.user);
          }
          setPending(null);
        }}
        onCancel={() => setPending(null)}
        testId={`staff-user-${pending?.kind ?? 'action'}-dialog`}
      />

      <PasswordResultModal
        show={passwordResult != null}
        onHide={() => setPasswordResult(null)}
        username={passwordResult?.username || ''}
        password={passwordResult?.password || ''}
      />
    </Container>
  );
};

export default StaffAdmin;
