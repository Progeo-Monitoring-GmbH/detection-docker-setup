import { useEffect, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { jwtDecode } from 'jwt-decode';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { setDemoToken } from './demo';

/**
 * Entry of a demo link (/demo/login/<token>): swaps the LimitedToken for the
 * JWT of the read-only "demo" user and opens the portal (DemoView), or
 * `?forward=` - an expired demo session comes back here (loginPathFor).
 * Public route; the token is never kept in the history, only in
 * localStorage for that re-login. The backend counts every opening of the
 * link - such a re-login is sent as `renewal` and doesn't count.
 */
const DemoLogin = () => {
  const { token } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t, i18n } = useTranslation();
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (!token) {
      setInvalid(true);
      return;
    }
    const forward = searchParams.get('forward') || '';
    // A renewal continues the visit of the expired session (its JWT is
    // still stored) instead of counting a new one.
    let session: string | undefined;
    if (forward) {
      try {
        session = jwtDecode<{ demo_session?: string }>(localStorage.getItem('authToken') || '').demo_session;
      } catch {
        session = undefined;
      }
    }
    void axiosConfig.perform_post(
      undefined,
      '/v1/demo/login/',
      { token, renewal: Boolean(forward), session, language: (i18n.language || '').slice(0, 2) },
      (response) => {
        auth.loginWithTokens(response.data.access, response.data.refresh);
        setDemoToken(token);
        // Only paths inside the app - never an absolute or protocol-relative URL.
        const internal = forward.startsWith('/') && !forward.startsWith('//');
        navigate(internal ? forward : '/demo/', { replace: true });
      },
      () => {
        setDemoToken(null);
        setInvalid(true);
      },
    );
    // Runs once per link; auth/navigate are stable enough for that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div
      className="d-flex justify-content-center align-items-center text-muted"
      style={{ minHeight: '100vh' }}
    >
      {invalid ? (
        t('demo_login_invalid')
      ) : (
        <>
          <Spinner animation="border" className="me-2" /> {t('demo_login_checking')}
        </>
      )}
    </div>
  );
};

export default DemoLogin;
