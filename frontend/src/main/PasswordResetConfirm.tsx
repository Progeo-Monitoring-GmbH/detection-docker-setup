import { useEffect, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import AuthPage, { AuthLinks, authButtonClass } from '../components/auth/AuthPage';
import { repeatedTestId } from '../testIds';

/**
 * Reset link from the "Passwort vergessen" mail (/passwort/neu/<token>).
 * Like VerifyAccess, the token is only checked on load (no side effect -
 * mail scanners open the link too); the new password is only set on the
 * button press, together with the code from the authenticator app (a
 * mailbox alone is not enough). Then the user is logged in like with a
 * login link - all other logins of the user ended.
 */
const PasswordResetConfirm = () => {
  const { token } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [state, setState] = useState<'checking' | 'invalid' | 'ready'>(
    token ? 'checking' : 'invalid',
  );
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [otp, setOtp] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      return;
    }
    void axiosConfig.perform_post(
      undefined,
      '/api/auth-support/password-reset/check/',
      { token },
      (response) => {
        setUsername(response.data.username || '');
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
      '/api/auth-support/password-reset/confirm/',
      { token, otp: otp.trim(), password },
      (response) => {
        auth.loginWithTokens(response.data.access, response.data.refresh);
        const forward = String(response.data.forward || '');
        // Only paths inside the app - never an absolute or protocol-relative URL.
        const internal = forward.startsWith('/') && !forward.startsWith('//');
        navigate(internal ? forward : '/', { replace: true });
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
        } else if (data.reason === 'otp_invalid') {
          setOtp('');
          setErrors([t('login_otp_invalid')]);
        } else if (data.reason === 'otp_required') {
          setErrors([t('password_new_otp_missing')]);
        } else if (err?.response?.status === 429) {
          setErrors([t('auth_too_many_requests')]);
        } else {
          setErrors([t('password_new_error')]);
        }
      },
    );
  };

  if (state === 'checking') {
    return (
      <AuthPage title={t('password_new_title')} testId="page-password-reset">
        <p className="auth-muted" data-testid="password-reset-checking">
          <Spinner animation="border" size="sm" className="me-2" />
          {t('access_verify_checking')}
        </p>
      </AuthPage>
    );
  }

  if (state === 'invalid') {
    return (
      <AuthPage title={t('password_new_title')} testId="page-password-reset">
        <p className="auth-muted" data-testid="password-reset-invalid">{t('password_new_invalid')}</p>
        <AuthLinks>
          <Link to="/passwort-vergessen" data-testid="password-reset-request-new">{t('password_new_request_new')}</Link>
          <Link to="/login" data-testid="auth-back-to-login">{t('auth_back_to_login')}</Link>
        </AuthLinks>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title={t('password_new_title')}
      intro={t('password_new_intro', { name: firstName || username })}
      testId="page-password-reset"
    >
      <form onSubmit={onSubmit} className="auth-form" data-testid="password-reset-form">
        <label className="auth-label">
          <span className="auth-field-label">{t('login_username')}</span>
          <input
            type="text"
            value={username}
            readOnly
            autoComplete="username"
            className="auth-field auth-field--readonly"
            data-testid="password-reset-username"
          />
        </label>
        <label className="auth-label">
          <span className="auth-field-label">{t('profile_new_password')}</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="auth-field"
            data-testid="password-reset-password"
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
            data-testid="password-reset-repeat"
          />
        </label>
        <label className="auth-label">
          <span className="auth-field-label">{t('login_otp_code')}</span>
          <input
            type="text"
            autoComplete="one-time-code"
            required
            value={otp}
            onChange={(event) => setOtp(event.target.value)}
            className="auth-field"
            data-testid="password-reset-otp"
          />
        </label>
        {errors.map((message) => (
          <p key={message} className="auth-error" {...repeatedTestId('password-reset-error', message)}>
            {message}
          </p>
        ))}
        <button type="submit" disabled={busy} className={authButtonClass(busy)} data-testid="password-reset-submit">
          {t('password_new_submit')}
        </button>
      </form>
    </AuthPage>
  );
};

export default PasswordResetConfirm;
