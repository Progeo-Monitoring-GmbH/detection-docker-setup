import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import {
  QA_CHECKED_EVENT,
  awardToastText,
  type QaNotification,
} from './qaScoreboardData';

/** How often a staff member's new fixes are looked for. */
export const QA_POLL_MS = 60_000;

/**
 * Tells a staff member about the points just earned on the readiness
 * scoreboard (POST /v1/qa/notifications/ - each fix once, then marked as
 * shown): every minute while the tab is visible, when it becomes visible
 * again and right after a checklist check (QA_CHECKED_EVENT). Staff only -
 * also in "show as normal user"; not while logged in as a customer.
 * Mounted once in App, renders nothing.
 */
export const QaAwardToasts = () => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const active = Boolean(auth.token) && auth.canViewAsUser;
  // The latest auth / t for the timer and listeners (registered once per activation).
  const latest = useRef({ auth, t, enqueueSnackbar });
  useEffect(() => {
    latest.current = { auth, t, enqueueSnackbar };
  });

  useEffect(() => {
    if (!active) {
      return undefined;
    }
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
    poll();
    const timer = window.setInterval(poll, QA_POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && poll();
    // The queued check of a change runs ~20 s later (backend RECHECK_DELAY):
    // looked for now and once more then.
    let followUp: number | undefined;
    const onChecked = () => {
      poll();
      window.clearTimeout(followUp);
      followUp = window.setTimeout(poll, 25_000);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(QA_CHECKED_EVENT, onChecked);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(followUp);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(QA_CHECKED_EVENT, onChecked);
    };
  }, [active]);

  return null;
};

export default QaAwardToasts;
