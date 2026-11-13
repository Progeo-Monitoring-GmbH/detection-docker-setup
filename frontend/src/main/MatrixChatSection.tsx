import React from 'react';
import { CheckCircleFill } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showSuccessBar } from '../components/ui/Snackbar.jsx';
import PillButton from '../components/ui/kit/PillButton';
import { formatDate } from './dateFormat';
import './MatrixChatSection.css';

type ChatApp = 'element_x' | 'fluffychat';

/** The chat apps users can sign in with - named with their logos everywhere. */
const CHAT_APPS: Record<ChatApp, { name: string; logo: string }> = {
  element_x: { name: 'Element X', logo: '/assets/chat-apps/element-x.png' },
  fluffychat: { name: 'FluffyChat', logo: '/assets/chat-apps/fluffychat.svg' },
};

const ChatAppLabel = ({ app, size = 18 }: { app: ChatApp; size?: number }) => (
  <span className="matrix-chat-app-label">
    <img
      src={CHAT_APPS[app].logo}
      alt=""
      width={size}
      height={size}
      className="matrix-chat-app-logo"
      style={{ borderRadius: size / 4.5 }}
    />
    {CHAT_APPS[app].name}
  </span>
);

export type MatrixAccount = {
  user_id: string;
  homeserver: string;
  /** Last login in a chat app (the portal handed MAS a token), ISO time. */
  connected_at?: string | null;
  /** Per app: the link behind its QR code and the code (PNG data URI). */
  apps: Record<ChatApp, { link: string; qr: string }>;
};

const POLL_MS = 4000;

/**
 * Mein Konto -> "ProGeo-Chat": the user's Matrix ID and how to sign in to a
 * chat app (helper/matrix_accounts.py). Without a connection yet - or when
 * another device should be added - a QR code per app; meanwhile it asks the
 * backend every few seconds whether an app signed in and then confirms it.
 */
/** `labelClassName`: the look of the section label - the drawer's own (UserProfile). */
const MatrixChatSection = ({ account, labelClassName }: { account: MatrixAccount; labelClassName: string }) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const [connectedAt, setConnectedAt] = React.useState<string | null>(account.connected_at || null);
  const [addDevice, setAddDevice] = React.useState(false);
  const [app, setApp] = React.useState<ChatApp>('element_x');
  const showCodes = !connectedAt || addDevice;

  // A login newer than the one known when the codes were shown confirms it.
  const baseline = React.useRef(connectedAt);
  React.useEffect(() => {
    if (!showCodes) {
      return undefined;
    }
    baseline.current = connectedAt;
    const timer = window.setInterval(() => {
      void axiosConfig.perform_get(
        auth,
        '/v1/user/matrix/',
        (response) => {
          const latest = (response?.data?.connected_at as string | null) || null;
          if (latest && latest !== baseline.current) {
            setConnectedAt(latest);
            setAddDevice(false);
            showSuccessBar(enqueueSnackbar, t('profile_chat_now_connected'));
          }
        },
        () => {},
      );
    }, POLL_MS);
    return () => window.clearInterval(timer);
    // connectedAt is the baseline only when the codes appear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, enqueueSnackbar, showCodes, t]);

  const current = account.apps[app];

  return (
    <section data-testid="matrix-chat">
      <div className={labelClassName}>{t('profile_section_chat')}</div>
      <div className="matrix-chat-body">
        <div>
          <span className="matrix-chat-muted">{t('profile_matrix_id')}: </span>
          <span className="matrix-chat-id" data-testid="matrix-chat-id">
            {account.user_id}
          </span>
        </div>

        {connectedAt && (
          <div className="matrix-chat-connected" data-testid="matrix-chat-connected">
            <CheckCircleFill size={15} className="matrix-chat-connected-icon" />
            <span>{t('profile_chat_connected', { date: formatDate(connectedAt) })}</span>
          </div>
        )}

        {connectedAt && (
          <div>
            <PillButton
              testId="matrix-chat-connect-more"
              label={addDevice ? t('profile_chat_hide') : t('profile_chat_connect_more')}
              onClick={() => setAddDevice((shown) => !shown)}
            />
          </div>
        )}

        {showCodes && (
          <>
            <div className="matrix-chat-apps" data-testid="matrix-chat-apps">
              {(Object.keys(CHAT_APPS) as ChatApp[]).map((key) => (
                <PillButton
                  key={key}
                  testId="matrix-chat-app"
                  testKey={key}
                  label={<ChatAppLabel app={key} />}
                  active={app === key}
                  variant="ghost"
                  onClick={() => setApp(key)}
                />
              ))}
            </div>
            <div className="matrix-chat-code" data-testid="matrix-chat-code">
              <img
                src={current.qr}
                alt={t('profile_chat_qr_alt', { app: CHAT_APPS[app].name })}
                width={148}
                height={148}
                className="matrix-chat-qr"
                data-testid="matrix-chat-qr"
              />
              <div className="matrix-chat-steps">
                <ChatAppLabel app={app} size={22} />
                <div>
                  {app === 'element_x'
                    ? t('profile_chat_element_steps')
                    : t('profile_chat_fluffychat_steps', { server: account.homeserver })}
                </div>
                <a href={current.link} target="_blank" rel="noreferrer" data-testid="matrix-chat-link">
                  {app === 'element_x' ? t('profile_chat_open_here') : t('profile_chat_get_app')}
                </a>
                <div className="matrix-chat-waiting" data-testid="matrix-chat-waiting">{t('profile_chat_waiting')}</div>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
};

export default MatrixChatSection;
