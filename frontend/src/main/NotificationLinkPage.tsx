import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import axiosConfig from '../axiosConfig';
import AuthPage, { AuthLinks, authButtonClass } from '../components/auth/AuthPage';

type LinkInfo = {
  kind: 'offline' | 'alarm';
  project_nr: number;
  project_name: string;
  case_number: string;
  state: 'open' | 'resolved';
  resolution: string;
  acknowledged: boolean;
  unsubscribed: boolean;
  address: string;
};

type Action = 'acknowledge' | 'unsubscribe';

/** The link's action: ?action=acknowledge|unsubscribe. */
const actionOf = (params: URLSearchParams): Action =>
  params.get('action') === 'unsubscribe' ? 'unsubscribe' : 'acknowledge';

/**
 * Target of the acknowledge / unsubscribe links in notification mails
 * (/notification/<token>?action=acknowledge|unsubscribe, backend
 * helper/notification_cases.py). Loading the page only reads what the link is
 * about - the action itself needs the button: mail scanners open every link
 * of a mail and must neither acknowledge an alarm nor unsubscribe anybody.
 * No login - the token from the mail is the key.
 */
const NotificationLinkPage = () => {
  const { token } = useParams();
  const [params] = useSearchParams();
  const { t } = useTranslation();
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [invalid, setInvalid] = useState(!token);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<string>('');
  const [action, setAction] = useState<Action>(actionOf(params));

  useEffect(() => {
    if (!token) {
      return;
    }
    void axiosConfig.perform_post(
      undefined,
      '/api/auth-support/notifications/check/',
      { token },
      (response) => setInfo(response.data as LinkInfo),
      () => setInvalid(true),
    );
  }, [token]);

  const run = () => {
    setBusy(true);
    setError('');
    const url = action === 'unsubscribe'
      ? '/api/auth-support/notifications/unsubscribe/'
      : '/api/auth-support/notifications/acknowledge/';
    void axiosConfig.perform_post(
      undefined,
      url,
      { token },
      (response) => {
        setBusy(false);
        const data = response.data as LinkInfo & { state?: string; recipients_left?: boolean };
        setInfo(data);
        if (action === 'unsubscribe') {
          setDone(t('notification_link_unsubscribed'));
        } else if (data.kind === 'alarm') {
          setDone(t('notification_link_alarm_acknowledged'));
        } else {
          setDone(t('notification_link_offline_acknowledged'));
        }
      },
      (err) => {
        setBusy(false);
        setError(err?.response?.status === 429 ? t('auth_too_many_requests') : t('notification_link_failed'));
      },
    );
  };

  if (invalid) {
    return (
      <AuthPage title={t('notification_link_title')} testId="page-notification-link">
        <p className="auth-muted" data-testid="notification-link-invalid">{t('notification_link_invalid')}</p>
        <AuthLinks>
          <Link to="/login" data-testid="auth-back-to-login">{t('auth_back_to_login')}</Link>
        </AuthLinks>
      </AuthPage>
    );
  }

  if (!info) {
    return <AuthPage title={t('notification_link_title')} testId="page-notification-link" />;
  }

  const kindLabel = info.kind === 'alarm' ? t('notification_kind_alarm') : t('notification_kind_offline');
  const resolved = info.state === 'resolved';
  let intro: string;
  if (action === 'unsubscribe') {
    intro = info.unsubscribed && !done
      ? t('notification_link_already_unsubscribed')
      : t('notification_link_unsubscribe_intro', { kind: kindLabel, project: info.project_nr });
  } else if (info.kind === 'alarm') {
    intro = resolved ? t('notification_link_alarm_already_done') : t('notification_link_alarm_intro');
  } else {
    intro = resolved ? t('notification_link_offline_resolved') : t('notification_link_offline_intro');
  }
  const canAct = !done && (action === 'unsubscribe' ? !info.unsubscribed : !resolved);
  let buttonLabel: string;
  if (action === 'unsubscribe') {
    buttonLabel = t('notification_link_unsubscribe_button');
  } else if (info.kind === 'alarm') {
    buttonLabel = t('notification_link_alarm_button');
  } else {
    buttonLabel = t('notification_link_offline_button');
  }

  return (
    <AuthPage title={t('notification_link_title')} testId="page-notification-link">
      <p className="auth-muted" data-testid="notification-link-case">
        {kindLabel} · {t('notification_link_project', { nr: info.project_nr, name: info.project_name })}
        <br />
        {t('notification_link_case', { number: info.case_number })}
      </p>
      {done ? (
        <p data-testid="notification-link-done">{done}</p>
      ) : (
        <p className="auth-muted" data-testid="notification-link-intro">{intro}</p>
      )}
      {error && <p className="auth-error" data-testid="notification-link-error">{error}</p>}
      {canAct && (
        <button
          type="button"
          disabled={busy}
          onClick={run}
          className={authButtonClass(busy, action === 'unsubscribe', 'auth-button--block')}
          data-testid="notification-link-submit"
        >
          {buttonLabel}
        </button>
      )}
      <AuthLinks>
        {action === 'acknowledge' && !info.unsubscribed && (
          <button
            type="button"
            className="btn btn-link p-0"
            onClick={() => { setAction('unsubscribe'); setDone(''); }}
            data-testid="notification-link-switch-unsubscribe"
          >
            {t('notification_link_switch_unsubscribe')}
          </button>
        )}
        <Link to="/login" data-testid="auth-back-to-login">{t('notification_link_to_portal')}</Link>
      </AuthLinks>
    </AuthPage>
  );
};

export default NotificationLinkPage;
