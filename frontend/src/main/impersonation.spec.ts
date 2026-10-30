// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../hooks/CoreAuthProvider';
import {
  clearImpersonation,
  impersonatorOf,
  isImpersonationBlockedError,
  startImpersonation,
  stopImpersonation,
} from './impersonation';

/** An unsigned JWT - jwtDecode doesn't check the signature. */
const jwt = (payload: Record<string, unknown>) =>
  ['{"alg":"none"}', JSON.stringify(payload), '']
    .map((part) =>
      btoa(part).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'),
    )
    .join('.');

const inSeconds = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

const fakeAuth = (token: string, refreshToken = 'own-refresh') =>
  ({
    token,
    refreshToken,
    loginWithTokens: vi.fn(),
    logoutAction: vi.fn(),
    navigate: vi.fn(),
  }) as unknown as AuthContextType;

describe('impersonation', () => {
  afterEach(() => clearImpersonation());

  it('reads the impersonator claim', () => {
    expect(impersonatorOf({ impersonator: 'admin' })).toBe('admin');
    expect(impersonatorOf({ username: 'kunde' })).toBeNull();
    expect(impersonatorOf(null)).toBeNull();
  });

  it('recognizes writes refused because of impersonation', () => {
    expect(
      isImpersonationBlockedError({ response: { data: { impersonation: true } } }),
    ).toBe(true);
    expect(isImpersonationBlockedError({ response: { status: 403 } })).toBe(false);
  });

  it('switches to the target and back to the own tokens', () => {
    const own = jwt({ username: 'admin', exp: inSeconds(600) });
    const auth = fakeAuth(own);

    startImpersonation(auth, 'target-access');
    expect(auth.loginWithTokens).toHaveBeenLastCalledWith('target-access', '');

    stopImpersonation(auth, '/staff/');
    expect(auth.loginWithTokens).toHaveBeenLastCalledWith(own, 'own-refresh');
    expect(auth.navigate).toHaveBeenCalledWith('/staff/');
    expect(auth.logoutAction).not.toHaveBeenCalled();
  });

  it('logs out when the own token expired meanwhile', () => {
    const auth = fakeAuth(jwt({ username: 'admin', exp: inSeconds(-1) }));

    startImpersonation(auth, 'target-access');
    stopImpersonation(auth, '/staff/');

    expect(auth.loginWithTokens).toHaveBeenCalledTimes(1);
    expect(auth.logoutAction).toHaveBeenCalledWith('/staff/');
  });

  it('keeps the own tokens only once', () => {
    const auth = fakeAuth(jwt({ exp: inSeconds(600) }));

    startImpersonation(auth, 'target-access');
    stopImpersonation(auth, '/staff/');
    stopImpersonation(auth, '/staff/');

    expect(auth.logoutAction).toHaveBeenCalledTimes(1);
  });
});
