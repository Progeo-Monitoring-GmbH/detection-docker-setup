import React from 'react';
import { Spinner, ProgressBar } from 'react-bootstrap';
import { X } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { errorReason, showErrorBar, showInfoBar, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PillButton from '../components/ui/kit/PillButton';
import LabeledInput from '../components/ui/kit/LabeledInput';
import { isDemoReadOnlyError, isDemoUser } from './demo';
import MatrixChatSection, { type MatrixAccount } from './MatrixChatSection';
import TwoFactorSettings from './TwoFactorSettings';
import { serverErrorText } from './twoFactor';
import './UserProfile.css';

type UserProfileResponse = {
  username: string;
  first_name?: string | null;
  last_name?: string | null;
  email: string;
  mobile?: string | null;
  messenger?: Messenger | null;
  messenger_id?: string | null;
  /** The messengers this server can send on (configured gateways). */
  messenger_services?: Messenger[];
  /** The user's account on our Matrix server (helper/matrix_accounts.py). */
  matrix?: MatrixAccount | null;
  language: string;
  two_factor_enabled?: boolean;
  /** False for users invited per link - they never chose a password. */
  has_usable_password?: boolean;
};

type Messenger = 'signal' | 'whatsapp' | 'matrix';

const MESSENGER_LABELS: Record<Messenger, string> = { signal: 'Signal', whatsapp: 'WhatsApp', matrix: 'Matrix' };

const isValidMatrixId = (input: string): boolean => /^@[^\s:]+:\S+$/.test(input.trim());

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
 * (ProGeo Portal v2.dc.html ~line 1215) - a right-side sliding panel rather
 * than the previous centered two-card Modal, same underlying data/actions.
 *
 * Deliberate departures from the mockup, since it's fake-data demo content:
 * - "Telefon" (landline) is dropped - only "Mobil" exists anywhere in the
 *   backend (UserProfile.mobile, used for SMS notifications already).
 * - "Benachrichtigungen" (a global Keine/E-Mail/SMS/Beides preference "for
 *   all projects") has no backing field anywhere - notification channel is
 *   real but per-object (ProgeoAccess, already editable on Rechte/
 *   Einstellungen), so a second, disconnected "global" toggle here would
 *   either do nothing or conflict with those. Omitted rather than faked.
 * - "Sprache" (language) is kept here even though the mockup's own account
 *   drawer doesn't list it - it's real, working, persisted server-side
 *   (unlike the header's quick, session-local DE/EN toggle), and dropping
 *   it would regress existing functionality just to match the mockup.
 * - "Zwei-Faktor-Anmeldung" (TwoFactorSettings) isn't in the mockup - it's
 *   the place to set up 2FA, and a password can be set with a 2FA code
 *   instead of the current one (users invited per link never had one).
 * - "Zugriff auf weiteres Projekt anfragen" and "Konto löschen" have no
 *   backend support (no request-access flow, no self-service account
 *   deactivation exists anywhere) - both show guidance to contact ProGeo
 *   directly instead of silently doing nothing or faking success.
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
  const [hasUsablePassword, setHasUsablePassword] = React.useState(true);

  const [firstName, setFirstName] = React.useState('');
  const [lastName, setLastName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [mobile, setMobile] = React.useState('');
  const [messenger, setMessenger] = React.useState<Messenger | ''>('');
  const [messengerId, setMessengerId] = React.useState('');
  const [messengerServices, setMessengerServices] = React.useState<Messenger[]>([]);
  const [matrixAccount, setMatrixAccount] = React.useState<MatrixAccount | null>(null);
  // Our own Matrix server: the account there is the address, nothing to type.
  const ownMatrixId = messenger === 'matrix' && matrixAccount ? matrixAccount.user_id : null;
  const [language, setLanguage] = React.useState('de');

  const [currentPassword, setCurrentPassword] = React.useState('');
  const [passwordCode, setPasswordCode] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = React.useState('');

  const canEditEmail = hasPermission('module_profile_mail_edit');
  // The demo user keeps nothing - no 2FA or password of its own.
  const isDemo = isDemoUser(auth.user);
  const isEmailInputValid = isValidEmail(email);

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
        setFirstName(data.first_name || '');
        setLastName(data.last_name || '');
        setEmail(data.email || '');
        setMobile(data.mobile || '');
        setMessenger(data.messenger || '');
        setMessengerId(data.messenger_id || '');
        setMessengerServices(data.messenger_services || []);
        setMatrixAccount(data.matrix || null);
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
    if (messenger === 'matrix' && !ownMatrixId && !isValidMatrixId(messengerId)) {
      showErrorBar(enqueueSnackbar, t('profile_matrix_id_invalid'));
      return;
    }
    setSaving(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/user/settings/',
      {
        first_name: firstName,
        last_name: lastName,
        email,
        mobile,
        messenger,
        messenger_id: messenger ? messengerId : '',
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
        const reason =
          error?.response?.data?.code === 'matrix_id_invalid'
            ? t('profile_matrix_id_invalid')
            : errorReason(error);
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

  if (!show) {
    return null;
  }

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
          <div className="profile-title">{t('profile_title')}</div>
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
                <LabeledInput label={t('profile_mobile')} value={mobile} onChange={setMobile} testId="user-profile-mobile" />
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
                {(messengerServices.length > 0 || messenger) && (
                  <>
                    <label className="profile-field">
                      <span className="profile-field-label">
                        {t('profile_messenger')}
                      </span>
                      <select
                        value={messenger}
                        onChange={(event) => setMessenger(event.target.value as Messenger | '')}
                        className="profile-select"
                        data-testid="user-profile-messenger"
                      >
                        <option value="">{t('profile_messenger_none')}</option>
                        {(Object.keys(MESSENGER_LABELS) as Messenger[])
                          .filter((service) => messengerServices.includes(service) || service === messenger)
                          .map((service) => (
                            <option key={service} value={service}>
                              {MESSENGER_LABELS[service]}
                            </option>
                          ))}
                      </select>
                    </label>
                    {messenger ? (
                      <LabeledInput
                        label={messenger === 'matrix' ? t('profile_matrix_id') : t('profile_messenger_number')}
                        value={ownMatrixId ?? messengerId}
                        onChange={ownMatrixId ? undefined : setMessengerId}
                        readOnly={Boolean(ownMatrixId)}
                        title={messenger === 'matrix' ? '@name:matrix.org' : t('profile_messenger_number_hint')}
                        testId="user-profile-messenger-id"
                      />
                    ) : (
                      <div />
                    )}
                    {messenger && (
                      <div className="profile-messenger-hint" data-testid="user-profile-messenger-hint">
                        {messenger === 'matrix'
                          ? t(ownMatrixId ? 'profile_messenger_own_matrix_hint' : 'profile_messenger_matrix_hint')
                          : t('profile_messenger_number_hint')}
                        {messenger === 'whatsapp' && <> {t('profile_messenger_whatsapp_hint')}</>}
                        {messenger !== 'matrix' && !messengerId.trim() && !mobile.trim() && (
                          <div className="profile-warning" data-testid="user-profile-messenger-no-number">{t('profile_messenger_no_number')}</div>
                        )}
                        {!messengerServices.includes(messenger) && (
                          <div className="profile-warning" data-testid="user-profile-messenger-unavailable">{t('profile_messenger_unavailable')}</div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </section>

            {matrixAccount && <MatrixChatSection account={matrixAccount} labelClassName="profile-section-label" />}

            <section data-testid="user-profile-access">
              <div className="profile-section-label">{t('profile_section_access')}</div>
              <div className="profile-actions">
                <PillButton
                  label={t('profile_request_access')}
                  onClick={() => showInfoBar(enqueueSnackbar, t('profile_request_access_info'))}
                  testId="user-profile-request-access"
                />
                {hasUsablePassword ? (
                  <PillButton label={t('profile_change_password')} onClick={() => togglePasswordMode('change')} testId="user-profile-change-password" />
                ) : (
                  <PillButton
                    label={t('profile_set_password')}
                    onClick={() => togglePasswordMode('set')}
                    disabled={!twoFactorEnabled}
                    testId="user-profile-set-password"
                  />
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
                  <PillButton
                    label={isSavingPassword ? t('profile_saving') : t('profile_save_password')}
                    onClick={changePassword}
                    disabled={isSavingPassword || !isPasswordInputValid}
                    testId="user-profile-save-password"
                  />
                </div>
              )}
            </section>

            {!isDemo && (
              <section data-testid="user-profile-two-factor">
                <div className="profile-section-label">{t('tfa_title')}</div>
                <TwoFactorSettings onEnabledChange={setTwoFactorEnabled} />
              </section>
            )}

            <section data-testid="user-profile-delete-account">
              <div className="profile-delete-title">{t('profile_delete_account')}</div>
              <div className="profile-delete-hint">{t('profile_delete_account_hint')}</div>
              <button
                type="button"
                onClick={() => showInfoBar(enqueueSnackbar, t('profile_delete_account_info'))}
                className="profile-delete-button"
                data-testid="user-profile-delete-account-button"
              >
                {t('profile_delete_account')}
              </button>
            </section>
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
    </div>
  );
};
