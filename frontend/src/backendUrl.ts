/**
 * Base URL of the backend. Without VITE_BACKEND_URL the backend is reached on
 * the page's own origin (nginx proxies /v1/, /api/, /ws/, ... to Django), so
 * the same build works under any hostname or IP.
 */
export const getBackendBaseUrl = () =>
  (import.meta.env.VITE_BACKEND_URL || window.location.origin).replace(/\/$/, '');

/** Base URL for WebSockets: VITE_WS_URL, else derived from the backend URL. */
export const getWsBaseUrl = () =>
  (import.meta.env.VITE_WS_URL || getBackendBaseUrl().replace(/^http/i, 'ws')).replace(/\/$/, '');

/** Absolute URL of a backend path (media files etc.); absolute URLs pass through. */
export const getBackendUrl = (path: string) => {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  return `${getBackendBaseUrl()}/${path.replace(/^\//, '')}`;
};
