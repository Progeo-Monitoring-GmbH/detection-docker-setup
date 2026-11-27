import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { getWsBaseUrl } from '../backendUrl';
import {
  QA_CHECKED_EVENT,
  QA_SOCKET_PATH,
  QA_UPDATED_EVENT,
  awardToastText,
  parseQaUpdate,
  type QaNotification,
  type QaUpdate,
} from './qaScoreboardData';
import { useLatestRef } from '../components/ui/useLatestRef';

/** How often new points are looked for while the live socket is down. */
const QA_POLL_MS = 60_000;
/** The socket's heartbeat comes every 20 s (backend) - silence this long: reconnect. */
const SOCKET_WATCHDOG_MS = 60_000;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 120_000;

/**
 * The live side of the readiness scoreboard for staff - mounted once in App,
 * renders nothing:
 *
 * - the websocket /ws/qa/ (backend QaScoreboardConsumer): every change of
 *   the points is passed on as QA_UPDATED_EVENT (the scoreboard reloads);
 * - the toast of points just earned (POST /v1/qa/notifications/ - each
 *   once): right away when the socket names the user, after a checklist
 *   check (QA_CHECKED_EVENT), when the tab becomes visible again - and every
 *   minute while the socket is down.
 *
 * Staff only - also in "show as normal user"; not while logged in as a customer.
 */
export const QaAwardToasts = () => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const active = Boolean(auth.token) && auth.canViewAsUser;
  const userId = (auth.user as { user_id?: number } | null)?.user_id ?? null;
  // The latest auth / t for the timer and listeners (registered once per activation).
  const latest = useLatestRef({ auth, t, enqueueSnackbar, userId });

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    let disposed = false;
    let busy = false;
    const poll = () => {
      if (busy || document.visibilityState === 'hidden') {
        return;
      }
      busy = true;
      const current = latest.current;
      void axiosConfig
        .perform_post(
          current.auth,
          '/v1/qa/notifications/',
          {},
          (response) => {
            const awards = (response?.data?.awards ?? []) as QaNotification[];
            if (awards.length) {
              current.enqueueSnackbar(awardToastText(current.t, awards), {
                variant: 'success',
              });
            }
          },
          // Quiet: the next poll tries again.
          () => undefined,
        )
        .finally(() => {
          busy = false;
        });
    };

    // -- the live socket -----------------------------------------------------------
    let socket: WebSocket | null = null;
    let socketOpen = false;
    let watchdog: number | undefined;
    let reconnectTimer: number | undefined;
    let reconnectDelay = RECONNECT_MIN_MS;
    const armWatchdog = () => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => socket?.close(), SOCKET_WATCHDOG_MS);
    };
    const onUpdate = (update: QaUpdate) => {
      window.dispatchEvent(
        new CustomEvent<QaUpdate>(QA_UPDATED_EVENT, { detail: update }),
      );
      const me = latest.current.userId;
      if (me != null && update.user_ids.includes(me)) {
        poll();
      }
    };
    const connect = () => {
      if (disposed || typeof WebSocket === 'undefined') {
        return;
      }
      const ws = new WebSocket(`${getWsBaseUrl()}${QA_SOCKET_PATH}`);
      socket = ws;
      ws.onopen = () => {
        socketOpen = true;
        reconnectDelay = RECONNECT_MIN_MS;
        armWatchdog();
        // Changes while the socket was down: looked for once.
        poll();
      };
      ws.onmessage = (event) => {
        armWatchdog();
        const update = parseQaUpdate(event.data);
        if (update) {
          onUpdate(update);
        }
      };
      ws.onclose = () => {
        socketOpen = false;
        window.clearTimeout(watchdog);
        if (!disposed) {
          reconnectTimer = window.setTimeout(connect, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
        }
      };
    };
    connect();

    poll();
    // The fallback while the socket is down (no channel layer, proxy, ...).
    const timer = window.setInterval(() => !socketOpen && poll(), QA_POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && poll();
    // A checklist check: points found by it come right away (the socket
    // tells too, but the toast must not wait for a reconnect).
    const onChecked = () => poll();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(QA_CHECKED_EVENT, onChecked);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.clearTimeout(watchdog);
      window.clearTimeout(reconnectTimer);
      socket?.close();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(QA_CHECKED_EVENT, onChecked);
    };
  }, [active, latest]);

  return null;
};
