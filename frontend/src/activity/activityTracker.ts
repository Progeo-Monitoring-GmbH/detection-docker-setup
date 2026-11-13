import { jwtDecode } from 'jwt-decode';
import { getBackendBaseUrl } from '../backendUrl';
import { readConsent } from '../components/privacy/consent';
import { readStoredTokens } from '../tokenRefresh';

/**
 * Usage analysis of normal users (backend: progeo/helper/activity.py,
 * POST /v1/activity/): page views with the time they were visible, clicks
 * and logins. Runs only while useActivityTracking switches it on - the
 * backend flag `activity_tracking` (tracking enabled, not staff) AND the
 * user's consent to "statistics". Events wait in memory only and go out in
 * batches every FLUSH_MS and when the tab is hidden or closed; a failed
 * request drops them (no retries, nothing stored in the browser).
 *
 * Nothing from the page's content leaves the browser: paths have their ids
 * and tokens replaced, a click is the element's data-testid or tag name.
 */

type ActivityKind = 'login' | 'page' | 'click';

export type ActivityEvent = {
  kind: ActivityKind;
  path: string;
  target?: string;
  duration_ms?: number;
  /** Epoch milliseconds - the backend takes it only within the last 24 h. */
  at: number;
};

export type ActivityBatch = { session: string; events: ActivityEvent[] };

export const FLUSH_MS = 15 * 1000;
/** The backend's limit per request (helper/activity.py MAX_EVENTS). */
export const MAX_BATCH = 100;
/** A login waits this long for the tracking to switch on (flag loading). */
const LOGIN_PENDING_MS = 60 * 1000;
const TARGET_MAX = 100;
const TOKEN_MIN_LENGTH = 16;

// The routes with the token of a mailed link (CoreRoutes.jsx).
const TOKEN_ROUTE = /^(\/login\/link\/|\/passwort\/neu\/|\/zugang\/bestaetigen\/|\/demo\/login\/)[^/]+/;

const normalizeSegment = (segment: string) => {
  if (/^\d+$/.test(segment)) {
    return ':id';
  }
  // Hashes, UUIDs, tokens: long, with letters and digits - route names have no digits.
  if (segment.length >= TOKEN_MIN_LENGTH && /\d/.test(segment) && /[a-z]/i.test(segment)) {
    return ':token';
  }
  return segment;
};

/** The route of `pathname` with ids and tokens replaced: /location/12/analyse -> /location/:id/analyse. */
export const normalizePath = (pathname: string) =>
  (pathname.split(/[?#]/, 1)[0] || '/')
    .replace(TOKEN_ROUTE, '$1:token')
    .split('/')
    .map(normalizeSegment)
    .join('/');

// What counts as a click: controls, not text or empty space. No <label>: a
// click on it reaches its input as a second click event.
const INTERACTIVE = [
  'button',
  'a[href]',
  'select',
  'summary',
  'input[type="checkbox"]',
  'input[type="radio"]',
  'input[type="submit"]',
  'input[type="button"]',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
].join(',');

const VALID_TARGET = /^[A-Za-z0-9_.:-]+$/;

/**
 * What a click on `node` hit: the data-testid of the clicked control or its
 * closest ancestor, else the control's tag name ("button"); null for clicks
 * outside any control. Never the element's text - it can contain names.
 */
export const clickTarget = (node: EventTarget | null): string | null => {
  const element =
    node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  const control = element?.closest(INTERACTIVE);
  if (!control) {
    return null;
  }
  const testId = control.closest('[data-testid]')?.getAttribute('data-testid') || '';
  return VALID_TARGET.test(testId) ? testId.slice(0, TARGET_MAX) : control.tagName.toLowerCase();
};

/** When the tracking runs (useActivityTracking) - every condition must hold. */
type TrackingGate = {
  loggedIn: boolean;
  /** The backend's `activity_tracking`: enabled and a normal user. */
  flag: boolean;
  /** Consent to "statistics" in the privacy settings (GDPR). */
  consent: boolean;
  /** Staff/superuser in "show as normal user". */
  staffAccount: boolean;
  /** A superuser logged in as this user. */
  impersonated: boolean;
};

export const shouldTrack = (gate: TrackingGate) =>
  gate.loggedIn && gate.flag && gate.consent && !gate.staffAccount && !gate.impersonated;

type Claims = { user_id?: number | string; impersonator?: string; exp?: number };

const claimsOf = (token: string): Claims | null => {
  if (!token) {
    return null;
  }
  try {
    return jwtDecode<Claims>(token);
  } catch {
    return null;
  }
};

/**
 * Whether adopting `next` (CoreAuthProvider.loginWithTokens) is a login:
 * another user than the current, still valid token - not a token swap after
 * a password/2FA change, and not "log in as" or the way back from it.
 */
export const startsNewSession = (previous: string, next: string, now = Date.now()) => {
  const nextClaims = claimsOf(next);
  if (!nextClaims || nextClaims.impersonator) {
    return false;
  }
  const previousClaims = claimsOf(previous);
  const previousValid = previousClaims && (previousClaims.exp == null || previousClaims.exp * 1000 > now);
  if (!previousValid) {
    return true;
  }
  return !previousClaims.impersonator && String(previousClaims.user_id) !== String(nextClaims.user_id);
};

const newSessionId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
};

const defaultSend = (batch: ActivityBatch) => {
  const token = readStoredTokens().access;
  if (!token) {
    return;
  }
  // keepalive: the request survives the tab being closed (pagehide).
  void fetch(`${getBackendBaseUrl()}/v1/activity/`, {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(batch),
  }).catch(() => {
    // Best effort - lost events only make the statistics a little smaller.
  });
};

type TrackerOptions = {
  send?: (batch: ActivityBatch) => void;
  now?: () => number;
  doc?: Document;
  win?: Window;
};

export const createActivityTracker = ({
  send = defaultSend,
  now = () => Date.now(),
  doc = document,
  win = window,
}: TrackerOptions = {}) => {
  let session = newSessionId();
  let active = false;
  let queue: ActivityEvent[] = [];
  let path = normalizePath(win.location?.pathname || '/');
  let rawPath = '';
  // The page in view: when it was opened, its visible time so far and
  // since when it is visible (null while the tab is hidden).
  let page: { path: string; startedAt: number; visibleMs: number; visibleSince: number | null } | null = null;
  let pendingLogin: { path: string; at: number } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const isVisible = () => doc.visibilityState !== 'hidden';

  const flush = () => {
    while (queue.length) {
      send({ session, events: queue.splice(0, MAX_BATCH) });
    }
  };

  const push = (event: ActivityEvent) => {
    queue.push(event);
    if (queue.length >= MAX_BATCH) {
      flush();
    }
  };

  const startPage = () => {
    const at = now();
    page = { path, startedAt: at, visibleMs: 0, visibleSince: isVisible() ? at : null };
  };

  const finishPage = () => {
    if (!page) {
      return;
    }
    const visibleMs = page.visibleMs + (page.visibleSince != null ? now() - page.visibleSince : 0);
    push({ kind: 'page', path: page.path, duration_ms: Math.max(0, Math.round(visibleMs)), at: page.startedAt });
    page = null;
  };

  const emitPendingLogin = () => {
    if (pendingLogin && now() - pendingLogin.at <= LOGIN_PENDING_MS) {
      push({ kind: 'login', ...pendingLogin });
    }
    pendingLogin = null;
  };

  const onClick = (event: Event) => {
    const target = clickTarget(event.target);
    if (target) {
      push({ kind: 'click', path, target, at: now() });
    }
  };

  const onVisibility = () => {
    if (!page) {
      return;
    }
    if (isVisible()) {
      page.visibleSince ??= now();
    } else {
      if (page.visibleSince != null) {
        page.visibleMs += now() - page.visibleSince;
        page.visibleSince = null;
      }
      flush();
    }
  };

  // Closing the tab (or leaving the app): the page ends here. A page that
  // comes back from the back/forward cache starts a new view.
  const onPageHide = () => {
    finishPage();
    flush();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted && !page) {
      startPage();
    }
  };

  const listen = (on: boolean) => {
    const method = on ? 'addEventListener' : 'removeEventListener';
    doc[method]('click', onClick, true);
    doc[method]('visibilitychange', onVisibility);
    win[method]('pagehide', onPageHide);
    win[method]('pageshow', onPageShow as EventListener);
  };

  return {
    /** Switch tracking on (starts a page view of the current route) or off (drops everything). */
    setActive(next: boolean) {
      if (next === active) {
        return;
      }
      active = next;
      if (next) {
        // A new session per activation: another user may have logged in meanwhile.
        session = newSessionId();
        listen(true);
        timer = setInterval(flush, FLUSH_MS);
        emitPendingLogin();
        startPage();
        return;
      }
      // Consent withdrawn or logged out: from now on nothing leaves the browser.
      listen(false);
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      queue = [];
      page = null;
      pendingLogin = null;
    },

    /** A route change: the previous page ends with its visible time. */
    pageChanged(pathname: string) {
      if (pathname === rawPath) {
        return;
      }
      rawPath = pathname;
      path = normalizePath(pathname);
      if (active) {
        finishPage();
        startPage();
      }
    },

    /**
     * A successful login (CoreAuthProvider). Only with consent to
     * "statistics"; sent once the tracking is on - for a staff member it
     * never is, and it expires after LOGIN_PENDING_MS.
     */
    markLogin(pathname = win.location?.pathname || '/') {
      if (!readConsent()?.categories.statistics) {
        return;
      }
      pendingLogin = { path: normalizePath(pathname), at: now() };
      if (active) {
        emitPendingLogin();
      }
    },

    flush,
  };
};

type ActivityTracker = ReturnType<typeof createActivityTracker>;

let instance: ActivityTracker | null = null;

/** The tracker of this tab (one per page load: one session id). */
export const activityTracker = (): ActivityTracker => {
  instance ??= createActivityTracker();
  return instance;
};

/** CoreAuthProvider after a successful login. */
export const markLogin = () => {
  if (typeof window !== 'undefined') {
    activityTracker().markLogin();
  }
};
