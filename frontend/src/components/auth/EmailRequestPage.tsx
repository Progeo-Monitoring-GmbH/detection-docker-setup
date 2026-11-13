import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import axiosConfig from '../../axiosConfig';
import AuthPage, { AuthLinks, authButtonClass } from './AuthPage';

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
  /** data-testid of the page root (`page-<name>`). */
  testId?: string;
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
  testId = 'page-email-request',
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
      <AuthPage title={t('magic_link_sent_title')} testId={testId}>
        <p className="auth-muted" data-testid="email-request-sent">{sentText}</p>
        <AuthLinks>
          <Link to="/login" data-testid="auth-back-to-login">{t('auth_back_to_login')}</Link>
        </AuthLinks>
      </AuthPage>
    );
  }

  return (
    <AuthPage title={title} intro={intro} testId={testId}>
      {notice}
      <form onSubmit={onSubmit} className="auth-form" data-testid="email-request-form">
        <label className="auth-label">
          <span className="auth-field-label">{t('access_email')}</span>
          <input
            type="email"
            autoComplete="email"
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="auth-field"
            data-testid="email-request-email"
          />
        </label>
        {error && <p className="auth-error" data-testid="email-request-error">{error}</p>}
        <button type="submit" disabled={busy} className={authButtonClass(busy)} data-testid="email-request-submit">
          {submitLabel}
        </button>
      </form>
      <AuthLinks>
        {extraLinks}
        <Link to="/login" data-testid="auth-back-to-login">{t('auth_back_to_login')}</Link>
      </AuthLinks>
    </AuthPage>
  );
};

export default EmailRequestPage;
