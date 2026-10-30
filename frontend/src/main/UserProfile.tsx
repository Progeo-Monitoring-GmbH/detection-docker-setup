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
import TwoFactorSettings from './TwoFactorSettings';
import { serverErrorText } from './twoFactor';

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

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: '.11em',
  textTransform: 'uppercase',
  color: '#8B8383',
  fontWeight: 500,
  marginBottom: 12,
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
    setSaving(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/user/settings/',
      { first_name: firstName, last_name: lastName, email, mobile, language },
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
        const reason = errorReason(error);
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
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(7, 34, 58, .38)',
        zIndex: 70,
        display: 'flex',
        justifyContent: 'flex-end',
        padding: 14,
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 'min(430px, 100%)',
          height: '100%',
          background: 'var(--progeo-panel-bg)',
          borderRadius: 20,
          boxShadow: '-10px 0 44px rgba(11, 54, 89, .26)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'auto',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '20px 22px 14px',
            position: 'sticky',
            top: 0,
            background: 'var(--progeo-panel-bg)',
            zIndex: 2,
          }}
        >
          <div style={{ fontSize: 17, fontWeight: 500 }}>{t('profile_title')}</div>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onHide}
            aria-label={t('profile_close')}
            style={{
              width: 34,
              height: 34,
              border: 'none',
              borderRadius: '50%',
              background: 'var(--progeo-surface)',
              boxShadow: '0 2px 8px rgba(11, 54, 89, .1)',
              cursor: 'pointer',
              color: 'var(--progeo-blue)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="d-flex align-items-center gap-2 text-muted py-4 px-4">
            <Spinner animation="border" size="sm" /> {t('profile_loading')}
          </div>
        ) : (
          <div style={{ padding: '0 22px 20px', display: 'flex', flexDirection: 'column', gap: 22 }}>
            <section>
              <div style={sectionLabelStyle}>{t('profile_section_contact')}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <LabeledInput label={t('profile_first_name')} value={firstName} onChange={setFirstName} />
                <LabeledInput label={t('profile_last_name')} value={lastName} onChange={setLastName} />
                <div style={{ gridColumn: 'span 2' }}>
                  <LabeledInput
                    label={t('profile_email')}
                    value={email}
                    onChange={canEditEmail ? setEmail : undefined}
                    readOnly={!canEditEmail}
                  />
                </div>
                <LabeledInput label={t('profile_mobile')} value={mobile} onChange={setMobile} />
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span style={{ fontSize: 11, letterSpacing: '.07em', textTransform: 'uppercase', color: '#8B8383', fontWeight: 500 }}>
                    {t('profile_language')}
                  </span>
                  <select
                    value={language}
                    onChange={(event) => setLanguage(event.target.value)}
                    style={{ height: 40, border: 'none', borderRadius: 11, background: 'var(--progeo-surface)', boxShadow: '0 1px 4px rgba(11,54,89,.09)', padding: '0 13px', fontFamily: 'inherit', fontSize: 14, color: 'var(--progeo-blue)' }}
                  >
                    <option value="de">Deutsch</option>
                    <option value="en">English</option>
                  </select>
                </label>
              </div>
            </section>

            <section>
              <div style={sectionLabelStyle}>{t('profile_section_access')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
                <PillButton
                  label={t('profile_request_access')}
                  onClick={() => showInfoBar(enqueueSnackbar, t('profile_request_access_info'))}
                />
                {hasUsablePassword ? (
                  <PillButton label={t('profile_change_password')} onClick={() => togglePasswordMode('change')} />
                ) : (
                  <PillButton
                    label={t('profile_set_password')}
                    onClick={() => togglePasswordMode('set')}
                    disabled={!twoFactorEnabled}
                  />
                )}
              </div>
              {!hasUsablePassword && (
                <div style={{ fontSize: 12.5, color: '#8B8383', marginTop: 8 }}>
                  {twoFactorEnabled ? t('profile_set_password_hint') : t('profile_set_password_needs_2fa')}
                </div>
              )}

              {passwordMode && (
                <div style={{ marginTop: 14, background: 'var(--progeo-surface)', borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {passwordMode === 'change' ? (
                    <LabeledInput
                      label={t('profile_current_password')}
                      value={currentPassword}
                      onChange={setCurrentPassword}
                      type="password"
                    />
                  ) : (
                    <LabeledInput
                      label={t('tfa_code')}
                      value={passwordCode}
                      onChange={setPasswordCode}
                      autoComplete="one-time-code"
                    />
                  )}
                  {passwordMode === 'change' && twoFactorEnabled && (
                    <button
                      type="button"
                      className="btn btn-link p-0 text-start"
                      style={{ fontSize: 12.5 }}
                      onClick={() => togglePasswordMode('set')}
                    >
                      {t('profile_forgot_password_2fa')}
                    </button>
                  )}
                  <LabeledInput
                    label={t('profile_new_password')}
                    value={newPassword}
                    onChange={setNewPassword}
                    type="password"
                  />
                  <div>
                    <div className="d-flex justify-content-between align-items-center mb-1">
                      <small className="text-muted">{t('profile_password_strength')}</small>
                      <small>{t(`profile_password_strength_${passwordStrength.level}`)}</small>
                    </div>
                    <ProgressBar
                      now={(passwordStrength.score / 6) * 100}
                      variant={passwordStrengthVariantByLevel[passwordStrength.level]}
                    />
                    <small className="text-muted d-block mt-2">{t('profile_password_requirements_hint')}</small>
                    <small className="d-block mt-1">
                      {passwordStrength.checks.minLength
                        ? t('profile_password_requirement_min_length_ok')
                        : t('profile_password_requirement_min_length')}
                    </small>
                    <small className="d-block">
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
                  />
                  <PillButton
                    label={isSavingPassword ? t('profile_saving') : t('profile_save_password')}
                    onClick={changePassword}
                    disabled={isSavingPassword || !isPasswordInputValid}
                  />
                </div>
              )}
            </section>

            {!isDemo && (
              <section>
                <div style={sectionLabelStyle}>{t('tfa_title')}</div>
                <TwoFactorSettings onEnabledChange={setTwoFactorEnabled} />
              </section>
            )}

            <section>
              <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 4 }}>{t('profile_delete_account')}</div>
              <div style={{ fontSize: 12.5, color: '#8B8383', marginBottom: 12 }}>{t('profile_delete_account_hint')}</div>
              <button
                type="button"
                onClick={() => showInfoBar(enqueueSnackbar, t('profile_delete_account_info'))}
                style={{ height: 36, padding: '0 15px', border: 'none', borderRadius: 10, background: '#FBEAE4', color: '#C44D26', fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
              >
                {t('profile_delete_account')}
              </button>
            </section>
          </div>
        )}

        <div
          style={{
            marginTop: 'auto',
            display: 'flex',
            gap: 10,
            padding: '14px 22px 20px',
            position: 'sticky',
            bottom: 0,
            background: 'var(--progeo-panel-bg)',
          }}
        >
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            style={{ height: 38, padding: '0 18px', border: 'none', borderRadius: 10, background: 'var(--progeo-orange)', color: '#fff', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 500, cursor: 'pointer', boxShadow: '0 4px 14px rgba(235, 99, 59, .26)' }}
          >
            {saving ? t('profile_saving') : t('profile_save_settings')}
          </button>
          <button
            type="button"
            onClick={onHide}
            style={{ height: 38, padding: '0 16px', border: 'none', borderRadius: 10, background: 'var(--progeo-surface)', boxShadow: '0 2px 8px rgba(11, 54, 89, .1)', color: 'var(--progeo-blue)', fontFamily: 'inherit', fontSize: 13.5, fontWeight: 500, cursor: 'pointer' }}
          >
            {t('profile_close')}
          </button>
        </div>
      </div>
    </div>
  );
};
