import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import axiosConfig from '../../axiosConfig';
import AuthPage, {
  AuthLinks,
  ERROR_TEXT,
  FIELD,
  FIELD_LABEL,
  FORM,
  LABEL,
  MUTED_TEXT,
  buttonStyle,
} from './AuthPage';

type EmailRequestPageProps = {
  /** Backend endpoint the address is posted to. */
  endpoint: string;
  title: string;
  intro: string;
  /** Shown above the form. */
  notice?: ReactNode;
  submitLabel: string;
  /** Confirmation after sending - the same for every address, so the page
   * doesn't reveal which addresses are registered. */
  sentText: string;
  /** Links shown before "back to login" below the form. */
  extraLinks?: ReactNode;
};

/** Asks for an e-mail address and posts it to `endpoint` (login link,
 * password reset). */
const EmailRequestPage = ({
  endpoint,
  title,
  intro,
  notice,
  submitLabel,
  sentText,
  extraLinks,
}: EmailRequestPageProps) => {
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
      endpoint,
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
        <p style={MUTED_TEXT}>{sentText}</p>
        <AuthLinks>
          <Link to="/login">{t('auth_back_to_login')}</Link>
        </AuthLinks>
      </AuthPage>
    );
  }

  return (
    <AuthPage title={title} intro={intro}>
      {notice}
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
          {submitLabel}
        </button>
      </form>
      <AuthLinks>
        {extraLinks}
        <Link to="/login">{t('auth_back_to_login')}</Link>
      </AuthLinks>
    </AuthPage>
  );
};

export default EmailRequestPage;
