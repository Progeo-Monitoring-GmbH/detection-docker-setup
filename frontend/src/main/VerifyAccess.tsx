import { useEffect, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import AuthPage, { AuthLinks, authButtonClass } from '../components/auth/AuthPage';
import { repeatedTestId } from '../testIds';

/**
 * Confirmation link of an access request (/zugang/bestaetigen/<token>). The
 * token is only checked on load (no side effect - mail scanners open the
 * link too); choosing a password confirms the address, creates the account
 * and logs the user in. Until the staff approved the request the portal
 * shows nothing but the "being checked" panel (PendingReview).
 */
const VerifyAccess = () => {
  const { token } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [state, setState] = useState<'checking' | 'invalid' | 'ready'>(
    token ? 'checking' : 'invalid',
  );
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      return;
    }
    void axiosConfig.perform_post(
      undefined,
      '/api/auth-support/access-requests/verify/check/',
      { token },
      (response) => {
        setEmail(response.data.email || '');
        setFirstName(response.data.first_name || '');
        setState('ready');
      },
      () => setState('invalid'),
    );
  }, [token]);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== repeat) {
      setErrors([t('access_verify_mismatch')]);
      return;
    }
    setErrors([]);
    setBusy(true);
    void axiosConfig.perform_post(
      undefined,
      '/api/auth-support/access-requests/verify/',
      { token, password },
      (response) => {
        auth.loginWithTokens(response.data.access, response.data.refresh);
        navigate('/zugang/pruefung', { replace: true });
      },
      (err) => {
        setBusy(false);
        const data = err?.response?.data || {};
        if (data.reason === 'password') {
          setErrors(
            data.errors?.length
              ? data.errors
              : [t('access_verify_password_invalid')],
          );
        } else if (data.reason === 'invalid_token') {
          setState('invalid');
        } else if (err?.response?.status === 429) {
          setErrors([t('auth_too_many_requests')]);
        } else {
          setErrors([t('access_verify_error')]);
        }
      },
    );
  };

  if (state === 'checking') {
    return (
      <AuthPage title={t('access_verify_title')} testId="page-verify-access">
        <p className="auth-muted" data-testid="verify-access-checking">
          <Spinner animation="border" size="sm" className="me-2" />
          {t('access_verify_checking')}
        </p>
      </AuthPage>
    );
  }

  if (state === 'invalid') {
    return (
      <AuthPage title={t('access_verify_title')} testId="page-verify-access">
        <p className="auth-muted" data-testid="verify-access-invalid">{t('access_verify_invalid')}</p>
        <AuthLinks>
          <Link to="/zugang/beantragen" data-testid="verify-access-request-access-link">{t('login_request_access')}</Link>
          <Link to="/login" data-testid="auth-back-to-login">{t('auth_back_to_login')}</Link>
        </AuthLinks>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title={t('access_verify_title')}
      intro={t('access_verify_intro', { name: firstName || email })}
      testId="page-verify-access"
    >
      <form onSubmit={onSubmit} className="auth-form" data-testid="verify-access-form">
        <label className="auth-label">
          <span className="auth-field-label">{t('access_email')}</span>
          <input
            type="email"
            value={email}
            readOnly
            autoComplete="username"
            className="auth-field auth-field--readonly"
            data-testid="verify-access-email"
          />
        </label>
        <label className="auth-label">
          <span className="auth-field-label">{t('login_password')}</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="auth-field"
            data-testid="verify-access-password"
          />
        </label>
        <label className="auth-label">
          <span className="auth-field-label">{t('access_verify_repeat')}</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
            className="auth-field"
            data-testid="verify-access-repeat"
          />
        </label>
        {errors.map((message) => (
          <p key={message} className="auth-error" {...repeatedTestId('verify-access-error', message)}>
            {message}
          </p>
        ))}
        <button type="submit" disabled={busy} className={authButtonClass(busy)} data-testid="verify-access-submit">
          {t('access_verify_submit')}
        </button>
      </form>
    </AuthPage>
  );
};

export default VerifyAccess;
