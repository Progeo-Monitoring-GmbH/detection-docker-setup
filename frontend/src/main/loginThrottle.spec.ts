import { describe, expect, it } from 'vitest';
import { loginRetryAfter } from './loginThrottle';

const failed = (status: number, data: unknown, headers: Record<string, string> = {}) => ({
  response: { status, data, headers },
});

describe('loginRetryAfter', () => {
  it('reads the seconds of the login throttle', () => {
    expect(loginRetryAfter(failed(429, { code: 'login_throttled', retry_after: 4 }))).toBe(4);
  });

  it('falls back to the Retry-After header', () => {
    expect(loginRetryAfter(failed(429, { code: 'login_throttled' }, { 'retry-after': '8' }))).toBe(8);
  });

  it('ignores other failures', () => {
    expect(loginRetryAfter(failed(401, { detail: 'No active account found with the given credentials' }))).toBeNull();
    // nginx's rate limit: 429 without the code.
    expect(loginRetryAfter(failed(429, '<html>Too Many Requests</html>'))).toBeNull();
    expect(loginRetryAfter(new Error('Network Error'))).toBeNull();
    expect(loginRetryAfter(null)).toBeNull();
  });
});
