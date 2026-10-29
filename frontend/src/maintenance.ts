import type { AxiosError, AxiosInstance } from 'axios';
import { getBackendUrl } from './backendUrl';

/**
 * Notices that the backend is gone - restarted, updated, still booting - while
 * the app is open, so it can show the "Wartungsarbeiten" screen instead of
 * failing requests (nginx only shows its own page on a full page load,
 * docker/nginx/snippets/maintenance.conf). Signals: nginx's 503 maintenance
 * answer, requests or WebSockets without any answer, and a heartbeat while
 * the tab is visible. Once the backend answers again the page reloads - the
 * frontend may have been updated meanwhile.
 */

/** Answers 204 without touching the database (progeo/urls.py). */
export const HEALTH_PATH = '/api/health/';
export const HEARTBEAT_MS = 30_000;
export const RETRY_MS = 5_000;
// A backend that is busy but there still counts as there - only "no
// connection" means gone (nginx then answers 503 at once).
const PROBE_TIMEOUT_MS = 10_000;
// nginx's answers for an upstream it can't reach (or that hangs).
const GATEWAY_STATUSES = new Set([502, 503, 504]);

type Listener = () => void;

let active = false;
let probing: Promise<boolean> | null = null;
const listeners = new Set<Listener>();

export const isMaintenance = () => active;

export function subscribeMaintenance(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setMaintenance(value: boolean) {
  if (active === value) {
    return;
  }
  active = value;
  listeners.forEach((listener) => listener());
}

/** Whether the backend answers at all. Any response but a gateway error
 * counts, also a refusal - the probe sends no credentials. no-cors: a dev
 * backend on another origin answers opaquely, which still is an answer. */
export async function backendReachable(): Promise<boolean> {
  try {
    const response = await fetch(getBackendUrl(HEALTH_PATH), {
      cache: 'no-store',
      mode: 'no-cors',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.type === 'opaque' || !GATEWAY_STATUSES.has(response.status);
  } catch (error) {
    return (error as Error)?.name === 'TimeoutError';
  }
}

/** Probes the backend (one probe at a time) and switches to maintenance
 * when it doesn't answer. Offline browsers are no maintenance. */
export function checkBackend(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return Promise.resolve(true);
  }
  if (!probing) {
    probing = backendReachable()
      .then((reachable) => {
        if (!reachable) {
          setMaintenance(true);
        }
        return reachable;
      })
      .finally(() => {
        probing = null;
      });
  }
  return probing;
}

/** nginx's JSON answer for API clients while the backend is unreachable
 * (docker/nginx/maintenance/maintenance.json). */
export const isMaintenanceAnswer = (error: AxiosError) =>
  error?.response?.status === 503 &&
  (error.response.data as { code?: string })?.code === 'maintenance';

/** Sorts a failed request: nginx's maintenance answer switches at once, a
 * gateway error or a request without any answer is checked with a probe.
 * Cancelled and timed-out requests say nothing about the backend. */
export function reportRequestError(error: AxiosError) {
  if (active || !error) {
    return;
  }
  if (isMaintenanceAnswer(error)) {
    setMaintenance(true);
    return;
  }
  const status = error.response?.status;
  if (
    (status && GATEWAY_STATUSES.has(status)) ||
    (!error.response && error.code === 'ERR_NETWORK')
  ) {
    void checkBackend();
  }
}

/** Lets every failed request of `instance` report to the watcher. */
export function watchAxios(instance: AxiosInstance) {
  instance.interceptors.response.use(undefined, (error) => {
    reportRequestError(error);
    return Promise.reject(error);
  });
}

/**
 * Heartbeat while the tab is visible (and at once when it becomes visible);
 * in maintenance it waits for the backend and reloads the page. Returns the
 * cleanup.
 */
export function startMaintenanceWatch(reload = () => window.location.reload()) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = () => {
    clearTimeout(timer);
    if (!stopped) {
      timer = setTimeout(tick, active ? RETRY_MS : HEARTBEAT_MS);
    }
  };
  const tick = async () => {
    if (active) {
      if (await backendReachable()) {
        reload();
        return;
      }
    } else if (document.visibilityState === 'visible') {
      await checkBackend();
    }
    schedule();
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible' && !active) {
      void checkBackend();
    }
  };
  // Switch to the faster retry right away.
  const onActivated = () => schedule();

  schedule();
  document.addEventListener('visibilitychange', onVisible);
  const unsubscribe = subscribeMaintenance(onActivated);
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
    unsubscribe();
  };
}

/** Test helper: back to "backend there". */
export function resetMaintenance() {
  active = false;
  probing = null;
}
