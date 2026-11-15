import React from 'react';
import { CheckCircleFill, ChatDotsFill } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showSuccessBar } from '../components/ui/Snackbar.jsx';
import PillButton from '../components/ui/kit/PillButton';
import { formatDate } from './dateFormat';
import MatrixSetupModal, { type SetupStep } from './MatrixSetupModal';
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
  /** Setup step 1: Element X (store, or the app with our server preset). */
  download?: { link: string; qr: string; stores: { ios?: string; android?: string } };
  /** Matrix is the user's messenger already. */
  primary?: boolean;
};

const POLL_MS = 4000;

/**
 * Mein Konto -> "ProGeo Chat", the recommended notification channel: a
 * highlighted card. Not connected yet: what it is good for and the button
 * into the setup dialog (MatrixSetupModal - install, QR code login without
 * password, test message, primary channel). Connected: the Matrix ID, the
 * last login and shortcuts into the dialog. Other chat apps (FluffyChat)
 * keep their per-app QR codes behind "Andere App".
 * `labelClassName`: the look of the section label - the drawer's own (UserProfile).
 */
const MatrixChatSection = ({
  account,
  labelClassName,
  onPrimary,
}: {
  account: MatrixAccount;
  labelClassName: string;
  onPrimary?: () => void;
}) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const [connectedAt, setConnectedAt] = React.useState<string | null>(account.connected_at || null);
  const [primary, setPrimary] = React.useState(Boolean(account.primary));
  const [setup, setSetup] = React.useState<SetupStep | null>(null);
  const [otherApp, setOtherApp] = React.useState(false);

  // The per-app codes (other apps): notice the login like the dialog does.
  const baseline = React.useRef(connectedAt);
  React.useEffect(() => {
    if (!otherApp) {
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
            setOtherApp(false);
            showSuccessBar(enqueueSnackbar, t('profile_chat_now_connected'));
          }
        },
        () => {},
      );
    }, POLL_MS);
    return () => window.clearInterval(timer);
    // connectedAt is the baseline only when the codes appear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, enqueueSnackbar, otherApp, t]);

  const fluffy = account.apps.fluffychat;

  return (
    <section className="matrix-chat" data-testid="matrix-chat">
      <div className="matrix-chat-head">
        <div className={labelClassName}>{t('profile_section_chat')}</div>
        <span className="matrix-chat-recommended" data-testid="matrix-chat-recommended">{t('matrix_recommended')}</span>
      </div>
      <div className="matrix-chat-body">
        {!connectedAt ? (
          <>
            <div className="matrix-chat-pitch">
              <ChatDotsFill size={22} className="matrix-chat-pitch-icon" />
              <span>{t('matrix_pitch')}</span>
            </div>
            <div>
              <PillButton
                variant="accent"
                label={t('matrix_setup_open')}
                onClick={() => setSetup(1)}
                testId="matrix-chat-setup"
              />
            </div>
          </>
        ) : (
          <>
            <div>
              <span className="matrix-chat-muted">{t('profile_matrix_id')}: </span>
              <span className="matrix-chat-id" data-testid="matrix-chat-id">{account.user_id}</span>
            </div>
            <div className="matrix-chat-connected" data-testid="matrix-chat-connected">
              <CheckCircleFill size={15} className="matrix-chat-connected-icon" />
              <span>{t('profile_chat_connected', { date: formatDate(connectedAt) })}</span>
            </div>
            {!primary && (
              <div className="matrix-chat-hint" data-testid="matrix-chat-not-primary">{t('matrix_not_primary_hint')}</div>
            )}
            <div className="matrix-chat-actions">
              {!primary && (
                <PillButton variant="accent" label={t('matrix_make_primary')} onClick={() => setSetup(3)} testId="matrix-chat-primary" />
              )}
              <PillButton label={t('profile_chat_connect_more')} onClick={() => setSetup(2)} testId="matrix-chat-connect-more" />
              <PillButton label={t('matrix_setup_test_send')} variant="ghost" onClick={() => setSetup(3)} testId="matrix-chat-test" />
            </div>
          </>
        )}

        <button
          type="button"
          className="matrix-chat-other"
          onClick={() => setOtherApp((shown) => !shown)}
          data-testid="matrix-chat-other-app"
        >
          {otherApp ? t('profile_chat_hide') : t('matrix_other_app')}
        </button>
        {otherApp && (
          <div className="matrix-chat-code" data-testid="matrix-chat-code">
            <img
              src={fluffy.qr}
              alt={t('profile_chat_qr_alt', { app: CHAT_APPS.fluffychat.name })}
              width={132}
              height={132}
              className="matrix-chat-qr"
              data-testid="matrix-chat-qr"
            />
            <div className="matrix-chat-steps">
              <ChatAppLabel app="fluffychat" size={22} />
              <div>{t('profile_chat_fluffychat_steps', { server: account.homeserver })}</div>
              <a href={fluffy.link} target="_blank" rel="noreferrer" data-testid="matrix-chat-link">
                {t('profile_chat_get_app')}
              </a>
              <div className="matrix-chat-waiting" data-testid="matrix-chat-waiting">{t('profile_chat_waiting')}</div>
            </div>
          </div>
        )}
      </div>

      <MatrixSetupModal
        show={setup !== null}
        initialStep={setup ?? 1}
        onHide={() => setSetup(null)}
        account={{ ...account, connected_at: connectedAt, primary }}
        onConnected={setConnectedAt}
        onPrimary={() => {
          setPrimary(true);
          onPrimary?.();
        }}
      />
    </section>
  );
};

export default MatrixChatSection;
