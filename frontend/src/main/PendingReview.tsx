import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import AuthPage, { MUTED_TEXT, buttonStyle } from '../components/auth/AuthPage';
import { COMPANY, telHref } from './company';

type ReviewStatus = 'pending' | 'approved' | 'rejected' | null;

const POLL_MS = 60 * 1000;

/**
 * The only page of a user whose access request still waits for the staff's
 * review (JWT claim `is_pending`, see PendingGate). Polls the request's
 * status; once approved, the user logs in again - the new token no longer
 * carries the claim. Meanwhile it offers the public, read-only demo
 * (`demo_url`) - opening it logs in the shared demo user instead.
 */
const PendingReview = () => {
  const auth = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [status, setStatus] = useState<ReviewStatus>('pending');
  const [demoUrl, setDemoUrl] = useState<string | null>(null);

  const loggedIn = Boolean(auth.token);

  const load = useCallback(() => {
    void axiosConfig.perform_get(
      auth,
      '/api/auth-support/access-requests/me/',
      (response) => {
        setStatus((response.data.status ?? null) as ReviewStatus);
        const url = String(response.data.demo_url || '');
        // Only paths inside the app - never an absolute or protocol-relative URL.
        setDemoUrl(url.startsWith('/') && !url.startsWith('//') ? url : null);
      },
      () => undefined,
    );
    // Polling only needs the session, not every change of the auth object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.token]);

  useEffect(() => {
    if (!loggedIn) {
      return undefined;
    }
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loggedIn, load]);

  if (!loggedIn) {
    return <Navigate to="/login" replace />;
  }

  if (status === 'approved' || status === null) {
    return (
      <AuthPage title={t('pending_approved_title')}>
        <p style={MUTED_TEXT}>{t('pending_approved_text')}</p>
        <button
          type="button"
          style={{ ...buttonStyle(), width: '100%' }}
          onClick={() => auth.logoutAction('/')}
        >
          {t('pending_login_again')}
        </button>
      </AuthPage>
    );
  }

  if (status === 'rejected') {
    return (
      <AuthPage title={t('pending_rejected_title')}>
        <p style={MUTED_TEXT}>{t('pending_rejected_text')}</p>
        <p style={MUTED_TEXT}>
          {t('login_phone')}:{' '}
          <a href={telHref(COMPANY.phone)}>{COMPANY.phone}</a>
          <br />
          {t('login_email')}:{' '}
          <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>
        </p>
        <button
          type="button"
          style={{ ...buttonStyle(false, true), width: '100%' }}
          onClick={() => auth.logoutAction()}
        >
          {t('pending_logout')}
        </button>
      </AuthPage>
    );
  }

  return (
    <AuthPage title={t('pending_title')}>
      <p style={MUTED_TEXT}>{t('pending_text')}</p>
      <p style={MUTED_TEXT}>{t('pending_text_mail')}</p>
      {demoUrl && (
        <>
          <p style={MUTED_TEXT}>{t('pending_demo_hint')}</p>
          <button
            type="button"
            style={{ ...buttonStyle(), width: '100%', marginTop: 0, marginBottom: 12 }}
            onClick={() => navigate(demoUrl)}
          >
            {t('pending_demo')}
          </button>
        </>
      )}
      <button
        type="button"
        style={{ ...buttonStyle(false, true), width: '100%' }}
        onClick={() => auth.logoutAction()}
      >
        {t('pending_logout')}
      </button>
    </AuthPage>
  );
};

export default PendingReview;
