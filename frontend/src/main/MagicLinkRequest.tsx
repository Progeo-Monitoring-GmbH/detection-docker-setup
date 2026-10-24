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
 * "Anmeldelink per E-Mail" (/login/link): the backend mails a one-time login
 * link if the address belongs to an account. The page always shows the same
 * confirmation, so it doesn't reveal which addresses are registered.
 */
const MagicLinkRequest = () => {
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
      '/api/auth-support/login-link/',
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
        <p style={MUTED_TEXT}>{t('magic_link_sent_text')}</p>
        <AuthLinks>
          <Link to="/login">{t('auth_back_to_login')}</Link>
        </AuthLinks>
      </AuthPage>
    );
  }

  return (
    <AuthPage title={t('magic_link_title')} intro={t('magic_link_intro')}>
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
          {t('magic_link_submit')}
        </button>
      </form>
      <AuthLinks>
        <Link to="/login">{t('auth_back_to_login')}</Link>
      </AuthLinks>
    </AuthPage>
  );
};

export default MagicLinkRequest;
