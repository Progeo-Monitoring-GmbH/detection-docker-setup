import { useEffect, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import AuthPage, { AuthLinks, authButtonClass } from '../components/auth/AuthPage';
import { repeatedTestId } from '../testIds';

/**
 * Target of the migration info mail (/konto/einrichten/<token>, backend
 * helper/migration_invites.py): users of the old platform choose their
 * password on the new one and are signed in right away. Loading the page
 * only checks the token (mail scanners open every link); the button sets
 * the password. Users with 2FA enter their code as a second step.
 */
const MigrationSetup = () => {
  const { token } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [state, setState] = useState<'checking' | 'invalid' | 'ready'>(token ? 'checking' : 'invalid');
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [otpStep, setOtpStep] = useState(false);
  const [otp, setOtp] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      return;
    }
    void axiosConfig.perform_post(
      undefined,
      '/api/auth-support/migration/check/',
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
      '/api/auth-support/migration/confirm/',
      otpStep ? { token, password, otp: otp.trim() } : { token, password },
      (response) => {
        auth.loginWithTokens(response.data.access, response.data.refresh);
        navigate('/', { replace: true });
      },
      (err) => {
        setBusy(false);
        const data = err?.response?.data || {};
        if (data.otp_required) {
          setOtpStep(true);
          setErrors(data.reason === 'otp_invalid' ? [t('login_otp_invalid')] : []);
        } else if (data.reason === 'password') {
          setErrors(data.errors?.length ? data.errors : [t('access_verify_password_invalid')]);
        } else if (data.reason === 'invalid_token') {
          setState('invalid');
        } else if (err?.response?.status === 429) {
          setErrors([t('auth_too_many_requests')]);
        } else {
          setErrors([t('migration_setup_error')]);
        }
      },
    );
  };

  if (state === 'checking') {
    return (
      <AuthPage title={t('migration_setup_title')} testId="page-migration-setup">
        <p className="auth-muted" data-testid="migration-setup-checking">
          <Spinner animation="border" size="sm" className="me-2" />
          {t('access_verify_checking')}
        </p>
      </AuthPage>
    );
  }

  if (state === 'invalid') {
    return (
      <AuthPage title={t('migration_setup_title')} testId="page-migration-setup">
        <p className="auth-muted" data-testid="migration-setup-invalid">{t('migration_setup_invalid')}</p>
        <AuthLinks>
          <Link to="/login/link" data-testid="migration-setup-request-link">{t('login_magic_link')}</Link>
          <Link to="/login" data-testid="auth-back-to-login">{t('auth_back_to_login')}</Link>
        </AuthLinks>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title={t('migration_setup_title')}
      intro={t('migration_setup_intro', { name: firstName || username })}
      testId="page-migration-setup"
    >
      <form onSubmit={onSubmit} className="auth-form" data-testid="migration-setup-form">
        <label className="auth-label">
          <span className="auth-field-label">{t('login_username')}</span>
          <input
            type="text"
            value={username}
            readOnly
            autoComplete="username"
            className="auth-field auth-field--readonly"
            data-testid="migration-setup-username"
          />
        </label>
        <label className="auth-label">
          <span className="auth-field-label">{t('migration_setup_password')}</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="auth-field"
            data-testid="migration-setup-password"
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
            data-testid="migration-setup-repeat"
          />
        </label>
        {otpStep && (
          <label className="auth-label">
            <span className="auth-field-label">{t('login_otp_code')}</span>
            <input
              type="text"
              autoComplete="one-time-code"
              required
              value={otp}
              onChange={(event) => setOtp(event.target.value)}
              className="auth-field"
              data-testid="migration-setup-otp"
            />
          </label>
        )}
        {errors.map((message) => (
          <p key={message} className="auth-error" {...repeatedTestId('migration-setup-error', message)}>
            {message}
          </p>
        ))}
        <button type="submit" disabled={busy} className={authButtonClass(busy)} data-testid="migration-setup-submit">
          {t('migration_setup_submit')}
        </button>
      </form>
    </AuthPage>
  );
};

export default MigrationSetup;
