import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
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
import { OtpReason, otpReason } from './twoFactor';

/**
 * Target of a one-time login link from a mail (/login/link/<token>). The
 * token is only redeemed on the button click, never on load: link scanners
 * of mail providers open every link of a mail and would use it up before
 * the customer gets there. Users with 2FA enter the code from their
 * authenticator app as a second step - the link stays valid meanwhile.
 */
const MagicLinkLogin = () => {
  const { token } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(!token);
  const [otpStep, setOtpStep] = useState<OtpReason | null>(null);
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');

  const onLogin = (event?: React.FormEvent) => {
    event?.preventDefault();
    setBusy(true);
    setError('');
    void axiosConfig.perform_post(
      undefined,
      '/api/auth-support/login-link/exchange/',
      otpStep ? { token, otp: otp.trim() } : { token },
      (response) => {
        auth.loginWithTokens(response.data.access, response.data.refresh);
        const forward = String(response.data.forward || '');
        // Only paths inside the app - never an absolute or protocol-relative URL.
        const internal = forward.startsWith('/') && !forward.startsWith('//');
        navigate(internal ? forward : '/', { replace: true });
      },
      (err) => {
        setBusy(false);
        const reason = otpReason(err);
        if (reason) {
          setOtpStep(reason);
          setOtp('');
        } else if (err?.response?.status === 429) {
          setError(t('auth_too_many_requests'));
        } else {
          setInvalid(true);
        }
      },
    );
  };

  if (invalid) {
    return (
      <AuthPage title={t('magic_link_login_title')}>
        <p style={MUTED_TEXT}>{t('magic_link_invalid')}</p>
        <AuthLinks>
          <Link to="/login/link">{t('magic_link_request_new')}</Link>
          <Link to="/login">{t('auth_back_to_login')}</Link>
        </AuthLinks>
      </AuthPage>
    );
  }

  if (otpStep) {
    return (
      <AuthPage title={t('login_otp_title')} intro={t('login_otp_intro')}>
        <form onSubmit={onLogin} style={FORM}>
          <label style={LABEL}>
            <span style={FIELD_LABEL}>{t('login_otp_code')}</span>
            <input
              type="text"
              autoComplete="one-time-code"
              autoFocus
              required
              value={otp}
              onChange={(event) => setOtp(event.target.value)}
              style={FIELD}
            />
          </label>
          {otpStep === 'otp_invalid' && (
            <p style={ERROR_TEXT}>{t('login_otp_invalid')}</p>
          )}
          {error && <p style={ERROR_TEXT}>{error}</p>}
          <button type="submit" disabled={busy} style={buttonStyle(busy)}>
            {t('login_otp_submit')}
          </button>
        </form>
      </AuthPage>
    );
  }

  return (
    <AuthPage
      title={t('magic_link_login_title')}
      intro={t('magic_link_login_intro')}
    >
      {error && <p style={ERROR_TEXT}>{error}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => onLogin()}
        style={{ ...buttonStyle(busy), width: '100%' }}
      >
        {t('magic_link_login_submit')}
      </button>
    </AuthPage>
  );
};

export default MagicLinkLogin;
