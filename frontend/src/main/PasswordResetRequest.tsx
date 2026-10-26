import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import axiosConfig from '../axiosConfig';
import AuthPage, {
  AuthLinks,
  ERROR_TEXT,
  FIELD,
  FIELD_LABEL,
  FORM,
  LABEL,
  MUTED_TEXT,
  buttonStyle,
} from '../components/auth/AuthPage';

/**
 * "Passwort vergessen" (/passwort-vergessen): the backend mails a reset link
 * (/passwort/neu/<token>) - only to users with 2FA, a mailbox alone must not
 * be enough to take over an account. Everyone else gets a mail explaining
 * the way in (login link, then 2FA in the profile). The page always shows
 * the same confirmation, so it doesn't reveal which addresses are registered.
 */
const PasswordResetRequest = () => {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    void axiosConfig.perform_post(
      undefined,
      '/api/auth-support/password-reset/',
      { email },
      () => setSent(true),
      (err) => {
        setBusy(false);
        setError(
          err?.response?.status === 429
            ? t('auth_too_many_requests')
            : t('magic_link_request_error'),
        );
      },
    );
  };

  if (sent) {
    return (
      <AuthPage title={t('magic_link_sent_title')}>
        <p style={MUTED_TEXT}>{t('password_reset_sent_text')}</p>
        <AuthLinks>
          <Link to="/login">{t('auth_back_to_login')}</Link>
        </AuthLinks>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title={t('password_reset_title')}
      intro={t('password_reset_intro')}
    >
      <p style={MUTED_TEXT}>{t('password_reset_2fa_hint')}</p>
      <form onSubmit={onSubmit} style={FORM}>
        <label style={LABEL}>
          <span style={FIELD_LABEL}>{t('access_email')}</span>
          <input
            type="email"
            autoComplete="email"
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            style={FIELD}
          />
        </label>
        {error && <p style={ERROR_TEXT}>{error}</p>}
        <button type="submit" disabled={busy} style={buttonStyle(busy)}>
          {t('password_reset_submit')}
        </button>
      </form>
      <AuthLinks>
        <Link to="/login/link">{t('login_magic_link')}</Link>
        <Link to="/login">{t('auth_back_to_login')}</Link>
      </AuthLinks>
    </AuthPage>
  );
};

export default PasswordResetRequest;
