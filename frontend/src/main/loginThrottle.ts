/**
 * Too many failed logins (backend helper/login_throttle.py): the login
 * endpoints refuse further attempts for a while - 3 failures are free, then
 * the wait doubles (2, 4, 8, ... s). They answer 429 with `Retry-After` and
 * `{ code: "login_throttled", retry_after: <seconds> }`.
 */

const LOGIN_THROTTLED_CODE = 'login_throttled';

interface FailedRequest {
  response?: {
    status?: number;
    data?: { code?: unknown; retry_after?: unknown };
    headers?: Record<string, unknown>;
  };
}

/** Seconds to wait when `error` is the login throttle's 429, else null. */
export const loginRetryAfter = (error: unknown): number | null => {
  const response = (error as FailedRequest | null)?.response;
  if (response?.status !== 429 || response.data?.code !== LOGIN_THROTTLED_CODE) {
    return null;
  }
  const seconds = Number(
    response.data?.retry_after ?? response.headers?.['retry-after'],
  );
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 1;
};
