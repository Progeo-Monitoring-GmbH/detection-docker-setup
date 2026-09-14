import React from 'react';
import { Spinner, ProgressBar } from 'react-bootstrap';
import { X } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import {
  showErrorBar,
  showInfoBar,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import PillButton from '../components/ui/kit/PillButton';
import LabeledInput from '../components/ui/kit/LabeledInput';

type UserProfileResponse = {
  username: string;
  first_name?: string | null;
  last_name?: string | null;
  email: string;
  mobile?: string | null;
  language: string;
};

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
  const [passwordOpen, setPasswordOpen] = React.useState(false);

  const [firstName, setFirstName] = React.useState('');
  const [lastName, setLastName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [mobile, setMobile] = React.useState('');
  const [language, setLanguage] = React.useState('de');

  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = React.useState('');

  const canEditEmail = hasPermission('module_profile_mail_edit');
  const isEmailInputValid = isValidEmail(email);

  const passwordStrength = evaluatePasswordStrength(newPassword);
  const isPasswordInputValid =
    Boolean(currentPassword) &&
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
        setLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `${t('profile_load_error')}: ${reason}`);
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, enqueueSnackbar]);

  React.useEffect(() => {
    if (!show) {
      return;
    }
    setPasswordOpen(false);
    setCurrentPassword('');
    setNewPassword('');
    setNewPasswordConfirm('');
    loadProfile();
  }, [show, loadProfile]);

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
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `${t('profile_settings_error')}: ${reason}`);
        setSaving(false);
      },
    );
  };

  const changePassword = () => {
    if (!currentPassword || !newPassword || !newPasswordConfirm) {
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
    void axiosConfig.perform_post(
      auth,
      '/v1/user/password/change/',
      { current_password: currentPassword, new_password: newPassword },
      () => {
        showSuccessBar(enqueueSnackbar, t('profile_password_saved'));
        setCurrentPassword('');
        setNewPassword('');
        setNewPasswordConfirm('');
        setPasswordOpen(false);
        setIsSavingPassword(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
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
                <PillButton label={t('profile_change_password')} onClick={() => setPasswordOpen((open) => !open)} />
              </div>

              {passwordOpen && (
                <div style={{ marginTop: 14, background: 'var(--progeo-surface)', borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <LabeledInput
                    label={t('profile_current_password')}
                    value={currentPassword}
                    onChange={setCurrentPassword}
                    type="password"
                  />
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

const UserProfile = () => {
  const { t } = useTranslation();
  const [showModal, setShowModal] = React.useState(true);

  return (
    <div>
      <UserProfileModal show={showModal} onHide={() => setShowModal(false)} />
      {!showModal && (
        <div className="d-flex justify-content-between align-items-center p-4">
          <span>{t('profile_modal_reopen_hint')}</span>
          <PillButton label={t('profile_settings_button')} onClick={() => setShowModal(true)} />
        </div>
      )}
    </div>
  );
};

export default UserProfile;
