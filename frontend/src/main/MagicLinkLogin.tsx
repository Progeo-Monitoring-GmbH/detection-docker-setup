import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import AuthPage, {
  AuthLinks,
  MUTED_TEXT,
  buttonStyle,
} from '../components/auth/AuthPage';

/**
 * Target of a one-time login link from a mail (/login/link/<token>). The
 * token is only redeemed on the button click, never on load: link scanners
 * of mail providers open every link of a mail and would use it up before
 * the customer gets there.
 */
const MagicLinkLogin = () => {
  const { token } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(!token);

  const onLogin = () => {
    setBusy(true);
    void axiosConfig.perform_post(
      undefined,
      '/api/auth-support/login-link/exchange/',
      { token },
      (response) => {
        auth.loginWithTokens(response.data.access, response.data.refresh);
        const forward = String(response.data.forward || '');
        // Only paths inside the app - never an absolute or protocol-relative URL.
        const internal = forward.startsWith('/') && !forward.startsWith('//');
        navigate(internal ? forward : '/', { replace: true });
      },
      () => {
        setBusy(false);
        setInvalid(true);
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

  return (
    <AuthPage
      title={t('magic_link_login_title')}
      intro={t('magic_link_login_intro')}
    >
      <button
        type="button"
        disabled={busy}
        onClick={onLogin}
        style={{ ...buttonStyle(busy), width: '100%' }}
      >
        {t('magic_link_login_submit')}
      </button>
    </AuthPage>
  );
};

export default MagicLinkLogin;
