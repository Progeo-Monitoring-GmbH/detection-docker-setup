import { useEffect, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';

/**
 * Entry of a demo link (/demo/login/<token>): swaps the LimitedToken for the
 * JWT of the "demo" user - which only holds the demo permission - and opens
 * the demo view. Public route; the token is never kept in the history.
 */
const DemoLogin = () => {
  const { token } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (!token) {
      setInvalid(true);
      return;
    }
    void axiosConfig.perform_post(
      undefined,
      '/v1/demo/login/',
      { token },
      (response) => {
        auth.loginWithTokens(response.data.access, response.data.refresh);
        navigate('/demo/', { replace: true });
      },
      () => setInvalid(true),
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
