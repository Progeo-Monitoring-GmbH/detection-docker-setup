import React from 'react';
import { Modal, Spinner, ProgressBar } from 'react-bootstrap';
import { Envelope, Key, ShieldLock, X } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { errorReason, showErrorBar, showInfoBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import LabeledInput from '../components/ui/kit/LabeledInput';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import PhoneInput from '../components/ui/PhoneInput';
import { isPhoneSavable } from '../components/ui/phone';
import { isDemoReadOnlyError, isDemoUser } from './demo';
import TwoFactorSettings from './TwoFactorSettings';
import { serverErrorText } from './twoFactor';
import './UserProfile.css';

type UserProfileResponse = {
  username: string;
  first_name?: string | null;
  last_name?: string | null;
  email: string;
  mobile?: string | null;
  language: string;
  two_factor_enabled?: boolean;
  /** False for users invited per link - they never chose a password. */
  has_usable_password?: boolean;
};

/** "Erika Muster" - the user's name, else the login name. */
export const displayName = (user: { first_name?: string | null; last_name?: string | null; username?: string | null }) =>
  [user.first_name, user.last_name].map((part) => (part || '').trim()).filter(Boolean).join(' ') || user.username || '';

/**
 * 'change': with the current password. 'set': with a 2FA code instead -
 * for users without a password (invited per link) or who forgot it.
 */
type PasswordMode = 'change' | 'set';

const isValidEmail = (input: string): boolean => {
  const value = input.trim();
  if (!value) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
};

type PasswordStrength = {
  score: number;
  level: 'very_weak' | 'weak' | 'medium' | 'strong' | 'very_strong';
  valid: boolean;
  checks: {
    minLength: boolean;
    lower: boolean;
    upper: boolean;
    digit: boolean;
    special: boolean;
    multipleCharsets: boolean;
  };
};

const evaluatePasswordStrength = (password: string): PasswordStrength => {
  const checks = {
    minLength: password.length >= 8,
    lower: /[a-z]/.test(password),
    upper: /[A-Z]/.test(password),
    digit: /\d/.test(password),
    special: /[^A-Za-z0-9]/.test(password),
    multipleCharsets: false,
  };

  const charsetCount = [
    checks.lower,
    checks.upper,
    checks.digit,
    checks.special,
  ].filter(Boolean).length;
  checks.multipleCharsets = charsetCount >= 3;

  const score = [
    checks.minLength,
    checks.lower,
    checks.upper,
    checks.digit,
    checks.special,
    checks.multipleCharsets,
  ].filter(Boolean).length;

  let level: PasswordStrength['level'] = 'very_weak';
  if (score >= 6) {
    level = 'very_strong';
  } else if (score >= 5) {
    level = 'strong';
  } else if (score >= 4) {
    level = 'medium';
  } else if (score >= 3) {
    level = 'weak';
  }

  return {
    score,
    level,
    valid: checks.minLength && checks.multipleCharsets,
    checks,
  };
};

type UserProfileModalProps = {
  show: boolean;
  onHide: () => void;
};

/**
 * "Mein Konto" account drawer, ported from the Portal v2 mockup
 * (ProGeo Portal v2.dc.html ~line 1215) - a right-side sliding panel.
 *
 * - The head shows the user's name (first + last, else the login name).
 * - Contact data: name, e-mail, mobile (PhoneInput, stored as E.164) and the
 *   language of the portal, the mails and the messenger messages.
 *   Messenger / ProGeo chat are not set up here: the notification channel
 *   (SMS or ProGeo chat) is chosen on an object's notifications tab
 *   (NotificationChannelCard).
 * - Access: "request access to another project" (a form mailed to the
 *   ProGeo staff, /v1/user/request-access/) and the password - buttons.
 * - Two-factor authentication: one button opens the setup dialog
 *   (TwoFactorSettings, with the current-password step).
 * - Delete account: self-service with a confirmation dialog that asks for
 *   the password (or a 2FA code for users without one).
 */
export const UserProfileModal = ({ show, onHide }: UserProfileModalProps) => {
  const auth = useAuth();
  const { hasPermission } = usePermissions();
  const { enqueueSnackbar } = useSnackbar();
  const { t, i18n } = useTranslation();

  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [isSavingPassword, setIsSavingPassword] = React.useState(false);
  const [passwordMode, setPasswordMode] = React.useState<PasswordMode | null>(null);
  const [twoFactorEnabled, setTwoFactorEnabled] = React.useState(false);
  const [twoFactorOpen, setTwoFactorOpen] = React.useState(false);
  const [hasUsablePassword, setHasUsablePassword] = React.useState(true);

  const [username, setUsername] = React.useState('');
  const [firstName, setFirstName] = React.useState('');
  const [lastName, setLastName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [mobile, setMobile] = React.useState('');
  const [language, setLanguage] = React.useState('de');

  const [currentPassword, setCurrentPassword] = React.useState('');
  const [passwordCode, setPasswordCode] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = React.useState('');

  const [requestOpen, setRequestOpen] = React.useState(false);
  const [requestProject, setRequestProject] = React.useState('');
  const [requestMessage, setRequestMessage] = React.useState('');
  const [requestSending, setRequestSending] = React.useState(false);

  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteProof, setDeleteProof] = React.useState('');
  const [deleting, setDeleting] = React.useState(false);

  const canEditEmail = hasPermission('module_profile_mail_edit');
  // The demo user keeps nothing - no 2FA, password, request or deletion of its own.
  const isDemo = isDemoUser(auth.user);
  const isEmailInputValid = isValidEmail(email);
  // Without a password the deletion is confirmed with a 2FA code (if there is 2FA).
  const deleteNeedsCode = !hasUsablePassword && twoFactorEnabled;
  const deleteNeedsProof = hasUsablePassword || twoFactorEnabled;

  const passwordStrength = evaluatePasswordStrength(newPassword);
  const isPasswordInputValid =
    Boolean(passwordMode === 'set' ? passwordCode.trim() : currentPassword) &&
    Boolean(newPassword) &&
    Boolean(newPasswordConfirm) &&
    newPassword === newPasswordConfirm &&
    passwordStrength.valid;

  const passwordStrengthVariantByLevel: Record<PasswordStrength['level'], string> = {
    very_weak: 'danger',
    weak: 'danger',
    medium: 'warning',
    strong: 'info',
    very_strong: 'success',
  };

  const loadProfile = React.useCallback(() => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      '/v1/user/profile/',
      (response) => {
        const data = (response?.data || {}) as UserProfileResponse;
        setUsername(data.username || '');
        setFirstName(data.first_name || '');
        setLastName(data.last_name || '');
        setEmail(data.email || '');
        setMobile(data.mobile || '');
        setLanguage(data.language || 'de');
        setTwoFactorEnabled(Boolean(data.two_factor_enabled));
        setHasUsablePassword(data.has_usable_password !== false);
        setLoading(false);
      },
      (error) => {
        const reason = errorReason(error);
        showErrorBar(enqueueSnackbar, `${t('profile_load_error')}: ${reason}`);
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, enqueueSnackbar]);

  const resetPasswordForm = () => {
    setPasswordMode(null);
    setCurrentPassword('');
    setPasswordCode('');
    setNewPassword('');
    setNewPasswordConfirm('');
  };

  // Only on opening: a 2FA change swaps the tokens (new auth object) - a
  // reload then would replace the drawer's content and lose the recovery
  // codes that are shown only once.
  React.useEffect(() => {
    if (!show) {
      return;
    }
    resetPasswordForm();
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  const togglePasswordMode = (mode: PasswordMode) => {
    const next = passwordMode === mode ? null : mode;
    resetPasswordForm();
    setPasswordMode(next);
  };

  const save = () => {
    if (!isEmailInputValid) {
      showErrorBar(enqueueSnackbar, t('profile_email_invalid'));
      return;
    }
    if (!isPhoneSavable(mobile)) {
      showErrorBar(enqueueSnackbar, t('phone_invalid'));
      return;
    }
    setSaving(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/user/settings/',
      // No messenger fields: the channel is chosen on the notifications tab,
      // the stored messenger stays as it is.
      {
        first_name: firstName,
        last_name: lastName,
        email,
        mobile,
        language,
      },
      async () => {
        await i18n.changeLanguage(language);
        showSuccessBar(enqueueSnackbar, t('profile_settings_saved'));
        setSaving(false);
        onHide();
      },
      async (error) => {
        if (isDemoReadOnlyError(error)) {
          // The demo keeps nothing, but the language switch works in the browser.
          await i18n.changeLanguage(language);
          showInfoBar(enqueueSnackbar, t('demo_read_only'));
          setSaving(false);
          onHide();
          return;
        }
        const reason = error?.response?.data?.code === 'phone_invalid' ? t('phone_invalid') : errorReason(error);
        showErrorBar(enqueueSnackbar, `${t('profile_settings_error')}: ${reason}`);
        setSaving(false);
      },
    );
  };

  const changePassword = () => {
    const proof = passwordMode === 'set' ? passwordCode.trim() : currentPassword;
    if (!proof || !newPassword || !newPasswordConfirm) {
      showErrorBar(enqueueSnackbar, t('profile_password_missing'));
      return;
    }
    if (newPassword !== newPasswordConfirm) {
      showErrorBar(enqueueSnackbar, t('profile_password_mismatch'));
      return;
    }
    if (!passwordStrength.valid) {
      showErrorBar(enqueueSnackbar, t('profile_password_weak'));
      return;
    }

    setIsSavingPassword(true);
    // Every login of the user ends - this device gets a fresh token pair back.
    void axiosConfig.perform_post(
      auth,
      passwordMode === 'set' ? '/v1/user/password/set/' : '/v1/user/password/change/',
      passwordMode === 'set'
        ? { code: proof, new_password: newPassword }
        : { current_password: proof, new_password: newPassword },
      (response) => {
        if (response?.data?.access && response?.data?.refresh) {
          auth.loginWithTokens(response.data.access, response.data.refresh);
        }
        showSuccessBar(enqueueSnackbar, t('profile_password_saved'));
        resetPasswordForm();
        setHasUsablePassword(true);
        setIsSavingPassword(false);
      },
      (error) => {
        const reason = serverErrorText(t, error, String(errorReason(error) || ''));
        showErrorBar(enqueueSnackbar, `${t('profile_password_error')}: ${reason}`);
        setIsSavingPassword(false);
      },
    );
  };

  const openRequest = () => {
    setRequestProject('');
    setRequestMessage('');
    setRequestOpen(true);
  };

  const sendRequest = () => {
    setRequestSending(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/user/request-access/',
      { project: requestProject.trim(), message: requestMessage.trim() },
      () => {
        setRequestSending(false);
        setRequestOpen(false);
        showSuccessBar(enqueueSnackbar, t('profile_request_access_sent'));
      },
      (error) => {
        setRequestSending(false);
        if (isDemoReadOnlyError(error)) {
          setRequestOpen(false);
          showInfoBar(enqueueSnackbar, t('demo_read_only'));
          return;
        }
        const code = error?.response?.data?.code;
        const reason = code === 'too_many_requests' ? t('profile_request_access_too_many') : errorReason(error);
        showErrorBar(enqueueSnackbar, `${t('profile_request_access_error')}: ${reason}`);
      },
    );
  };

  const openDelete = () => {
    setDeleteProof('');
    setDeleteOpen(true);
  };

  const deleteAccount = () => {
    setDeleting(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/user/delete-account/',
      deleteNeedsCode ? { confirm: true, code: deleteProof.trim() } : { confirm: true, password: deleteProof },
      () => {
        setDeleting(false);
        setDeleteOpen(false);
        showSuccessBar(enqueueSnackbar, t('profile_delete_account_done'));
        onHide();
        auth.logoutAction();
      },
      (error) => {
        setDeleting(false);
        const code = error?.response?.data?.code;
        const reason = code === 'last_superuser'
          ? t('profile_delete_account_last_superuser')
          : serverErrorText(t, error, String(errorReason(error) || ''));
        showErrorBar(enqueueSnackbar, `${t('profile_delete_account_error')}: ${reason}`);
      },
    );
  };

  if (!show) {
    return null;
  }

  const name = displayName({ first_name: firstName, last_name: lastName, username });

  return (
    <div
      onClick={onHide}
      className="profile-backdrop"
      data-testid="user-profile-backdrop"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="profile-drawer"
        data-testid="user-profile"
      >
        <div className="profile-head">
          <div>
            <div className="profile-title">{t('profile_title')}</div>
            {!loading && name && (
              <div className="profile-subtitle" data-testid="user-profile-name">{name}</div>
            )}
          </div>
          <div className="profile-spacer" />
          <button
            type="button"
            onClick={onHide}
            aria-label={t('profile_close')}
            className="profile-close"
            data-testid="user-profile-close"
          >
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="d-flex align-items-center gap-2 text-muted py-4 px-4" data-testid="user-profile-loading">
            <Spinner animation="border" size="sm" /> {t('profile_loading')}
          </div>
        ) : (
          <div className="profile-body">
            <section data-testid="user-profile-contact">
              <div className="profile-section-label">{t('profile_section_contact')}</div>
              <div className="profile-grid">
                <LabeledInput label={t('profile_first_name')} value={firstName} onChange={setFirstName} testId="user-profile-first-name" />
                <LabeledInput label={t('profile_last_name')} value={lastName} onChange={setLastName} testId="user-profile-last-name" />
                <div className="profile-span-2">
                  <LabeledInput
                    label={t('profile_email')}
                    value={email}
                    onChange={canEditEmail ? setEmail : undefined}
                    readOnly={!canEditEmail}
                    testId="user-profile-email"
                  />
                </div>
                <div className="profile-span-2">
                  <PhoneInput label={t('profile_mobile')} value={mobile} onChange={setMobile} testId="user-profile-mobile" />
                </div>
                <label className="profile-field">
                  <span className="profile-field-label">
                    {t('profile_language')}
                  </span>
                  <select
                    value={language}
                    onChange={(event) => setLanguage(event.target.value)}
                    className="profile-select"
                    data-testid="user-profile-language"
                  >
                    <option value="de">Deutsch</option>
                    <option value="en">English</option>
                  </select>
                </label>
              </div>
            </section>

            <section data-testid="user-profile-access">
              <div className="profile-section-label">{t('profile_section_access')}</div>
              <div className="profile-actions">
                {!isDemo && (
                  <button type="button" className="profile-button profile-action" onClick={openRequest} data-testid="user-profile-request-access">
                    <Envelope size={15} aria-hidden="true" />
                    {t('profile_request_access')}
                  </button>
                )}
                {hasUsablePassword ? (
                  <button
                    type="button"
                    className={`profile-button profile-action${passwordMode === 'change' ? ' profile-action--open' : ''}`}
                    onClick={() => togglePasswordMode('change')}
                    aria-expanded={passwordMode === 'change'}
                    data-testid="user-profile-change-password"
                  >
                    <Key size={15} aria-hidden="true" />
                    {t('profile_change_password')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`profile-button profile-action${passwordMode === 'set' ? ' profile-action--open' : ''}`}
                    onClick={() => togglePasswordMode('set')}
                    disabled={!twoFactorEnabled}
                    aria-expanded={passwordMode === 'set'}
                    data-testid="user-profile-set-password"
                  >
                    <Key size={15} aria-hidden="true" />
                    {t('profile_set_password')}
                  </button>
                )}
              </div>
              {!hasUsablePassword && (
                <div className="profile-hint" data-testid="user-profile-set-password-hint">
                  {twoFactorEnabled ? t('profile_set_password_hint') : t('profile_set_password_needs_2fa')}
                </div>
              )}

              {passwordMode && (
                <div className="profile-password-panel" data-testid="user-profile-password-panel">
                  {passwordMode === 'change' ? (
                    <LabeledInput
                      label={t('profile_current_password')}
                      value={currentPassword}
                      onChange={setCurrentPassword}
                      type="password"
                      testId="user-profile-current-password"
                    />
                  ) : (
                    <LabeledInput
                      label={t('tfa_code')}
                      value={passwordCode}
                      onChange={setPasswordCode}
                      autoComplete="one-time-code"
                      testId="user-profile-password-code"
                    />
                  )}
                  {passwordMode === 'change' && twoFactorEnabled && (
                    <button
                      type="button"
                      className="btn btn-link p-0 text-start profile-link-button"
                      onClick={() => togglePasswordMode('set')}
                      data-testid="user-profile-forgot-password-2fa"
                    >
                      {t('profile_forgot_password_2fa')}
                    </button>
                  )}
                  <LabeledInput
                    label={t('profile_new_password')}
                    value={newPassword}
                    onChange={setNewPassword}
                    type="password"
                    testId="user-profile-new-password"
                  />
                  <div>
                    <div className="d-flex justify-content-between align-items-center mb-1">
                      <small className="text-muted">{t('profile_password_strength')}</small>
                      <small data-testid="user-profile-password-strength-level">{t(`profile_password_strength_${passwordStrength.level}`)}</small>
                    </div>
                    <ProgressBar
                      now={(passwordStrength.score / 6) * 100}
                      variant={passwordStrengthVariantByLevel[passwordStrength.level]}
                      data-testid="user-profile-password-strength"
                    />
                    <small className="text-muted d-block mt-2">{t('profile_password_requirements_hint')}</small>
                    <small className="d-block mt-1" data-testid="user-profile-password-min-length">
                      {passwordStrength.checks.minLength
                        ? t('profile_password_requirement_min_length_ok')
                        : t('profile_password_requirement_min_length')}
                    </small>
                    <small className="d-block" data-testid="user-profile-password-charset">
                      {passwordStrength.checks.multipleCharsets
                        ? t('profile_password_requirement_charset_ok')
                        : t('profile_password_requirement_charset')}
                    </small>
                  </div>
                  <LabeledInput
                    label={t('profile_confirm_password')}
                    value={newPasswordConfirm}
                    onChange={setNewPasswordConfirm}
                    type="password"
                    testId="user-profile-confirm-password"
                  />
                  <button
                    type="button"
                    className="profile-button profile-button--primary profile-action"
                    onClick={changePassword}
                    disabled={isSavingPassword || !isPasswordInputValid}
                    data-testid="user-profile-save-password"
                  >
                    {isSavingPassword ? t('profile_saving') : t('profile_save_password')}
                  </button>
                </div>
              )}
            </section>

            {!isDemo && (
              <section data-testid="user-profile-two-factor">
                <div className="profile-section-label">{t('tfa_title')}</div>
                <div className="profile-status-row">
                  <span
                    className={twoFactorEnabled ? 'profile-status profile-status--on' : 'profile-status'}
                    data-testid="user-profile-two-factor-status"
                  >
                    {twoFactorEnabled ? t('tfa_status_on') : t('tfa_status_off')}
                  </span>
                </div>
                <div className="profile-actions">
                  <button
                    type="button"
                    className="profile-button profile-action"
                    onClick={() => setTwoFactorOpen(true)}
                    data-testid="user-profile-two-factor-open"
                  >
                    <ShieldLock size={15} aria-hidden="true" />
                    {twoFactorEnabled ? t('tfa_manage_button') : t('tfa_setup_button')}
                  </button>
                </div>
              </section>
            )}

            {!isDemo && (
              <section data-testid="user-profile-delete-account">
                <div className="profile-delete-title">{t('profile_delete_account')}</div>
                <div className="profile-delete-hint">{t('profile_delete_account_hint')}</div>
                <button
                  type="button"
                  onClick={openDelete}
                  className="profile-delete-button"
                  data-testid="user-profile-delete-account-button"
                >
                  {t('profile_delete_account')}
                </button>
              </section>
            )}
          </div>
        )}

        <div className="profile-foot">
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            className="profile-button profile-button--primary"
            data-testid="user-profile-save"
          >
            {saving ? t('profile_saving') : t('profile_save_settings')}
          </button>
          <button
            type="button"
            onClick={onHide}
            className="profile-button"
            data-testid="user-profile-footer-close"
          >
            {t('profile_close')}
          </button>
        </div>
      </div>

      {/* The dialogs sit above the drawer; clicks inside must not close it. */}
      <div onClick={(event) => event.stopPropagation()}>
        <ConfirmDialog
          testId="user-profile-request-access-dialog"
          show={requestOpen}
          danger={false}
          title={t('profile_request_access')}
          confirmLabel={t('profile_request_access_send')}
          cancelLabel={t('tfa_cancel')}
          confirming={requestSending}
          confirmDisabled={!requestProject.trim()}
          onCancel={() => setRequestOpen(false)}
          onConfirm={sendRequest}
          message={
            <div className="profile-dialog-form">
              <p className="profile-dialog-text">{t('profile_request_access_intro')}</p>
              <LabeledInput
                label={t('profile_request_access_project')}
                value={requestProject}
                onChange={setRequestProject}
                testId="user-profile-request-access-project"
              />
              <label className="progeo-field">
                <span className="progeo-field-label">
                  {t('profile_request_access_message')} ({t('access_optional')})
                </span>
                <textarea
                  rows={3}
                  value={requestMessage}
                  onChange={(event) => setRequestMessage(event.target.value)}
                  className="profile-textarea"
                  data-testid="user-profile-request-access-message"
                />
              </label>
            </div>
          }
        />

        <ConfirmDialog
          testId="user-profile-delete-account-dialog"
          show={deleteOpen}
          title={t('profile_delete_account_confirm_title')}
          confirmLabel={t('profile_delete_account_confirm')}
          cancelLabel={t('tfa_cancel')}
          confirming={deleting}
          confirmDisabled={deleteNeedsProof && !deleteProof.trim()}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={deleteAccount}
          message={
            <div className="profile-dialog-form">
              <p className="profile-dialog-text">{t('profile_delete_account_confirm_text')}</p>
              {deleteNeedsProof && (
                <LabeledInput
                  label={deleteNeedsCode ? t('tfa_code') : t('profile_current_password')}
                  value={deleteProof}
                  onChange={setDeleteProof}
                  type={deleteNeedsCode ? 'text' : 'password'}
                  autoComplete={deleteNeedsCode ? 'one-time-code' : 'current-password'}
                  testId="user-profile-delete-account-proof"
                />
              )}
            </div>
          }
        />

        {/* A portal - React still bubbles its clicks up to the backdrop. */}
        <Modal
          show={twoFactorOpen}
          onHide={() => setTwoFactorOpen(false)}
          centered
          className="profile-two-factor-modal"
          data-testid="user-profile-two-factor-dialog"
        >
          <Modal.Header closeButton>
            <Modal.Title className="profile-title">{t('tfa_title')}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <TwoFactorSettings onEnabledChange={setTwoFactorEnabled} />
          </Modal.Body>
        </Modal>
      </div>
    </div>
  );
};
