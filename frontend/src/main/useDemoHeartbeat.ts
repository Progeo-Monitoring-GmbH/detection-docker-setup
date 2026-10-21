import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import { useConsent } from '../components/privacy/ConsentProvider';
import axiosConfig from '../axiosConfig';
import { isDemoUser } from './demo';

/** Interval of the heartbeat (the backend counts gaps up to 75 s as active). */
const HEARTBEAT_MS = 30 * 1000;
/** The visitor counts as active this long after the last input. */
const ACTIVE_WINDOW_MS = 60 * 1000;
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart'] as const;

/**
 * How long a demo visitor actually uses the demo (DemoSession on the
 * backend): while the tab is visible and there was input in the last
 * ACTIVE_WINDOW_MS, a heartbeat goes out every HEARTBEAT_MS, plus one on
 * every page change (a page view). Nothing is stored in the browser - the
 * session travels in the demo login's JWT. Only with the visitor's consent
 * ("statistics", see the cookie banner); does nothing for other users.
 */
const useDemoHeartbeat = () => {
  const auth = useAuth();
  const { pathname } = useLocation();
  const { allows } = useConsent();
  const demo = isDemoUser(auth.user) && allows('statistics');
  const lastActivity = useRef(Date.now());
  const pageRef = useRef(pathname);
  pageRef.current = pathname;
  const authRef = useRef(auth);
  authRef.current = auth;

  const send = useRef((page: string) => {
    if (document.visibilityState !== 'visible') {
      return;
    }
    void axiosConfig.perform_post(
      authRef.current,
      '/v1/demo/heartbeat/',
      { page },
      () => {},
      () => {}, // best effort - a lost heartbeat only shortens the active time
    );
  });

  useEffect(() => {
    if (!demo) {
      return undefined;
    }
    const markActive = () => {
      lastActivity.current = Date.now();
    };
    ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, markActive, { passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity.current < ACTIVE_WINDOW_MS) {
        send.current(pageRef.current);
      }
    }, HEARTBEAT_MS);
    return () => {
      ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, markActive));
      window.clearInterval(timer);
    };
  }, [demo]);

  // A page change is activity and a page view.
  useEffect(() => {
    if (demo) {
      lastActivity.current = Date.now();
      send.current(pathname);
    }
  }, [demo, pathname]);
};

export default useDemoHeartbeat;
