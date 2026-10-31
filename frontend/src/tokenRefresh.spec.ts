// @vitest-environment jsdom
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearStoredTokens,
  onTokensRefreshed,
  readStoredTokens,
  refreshAccessToken,
  shouldRefreshAccessToken,
  storeTokens,
} from './tokenRefresh';

const jwt = (exp: number) => {
  const payload = btoa(JSON.stringify({ exp }))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('token storage', () => {
  it('stores and clears both tokens', () => {
    storeTokens('access-1', 'refresh-1');
    expect(readStoredTokens()).toEqual({ access: 'access-1', refresh: 'refresh-1' });

    clearStoredTokens();
    expect(readStoredTokens()).toEqual({ access: '', refresh: '' });
  });

  it('removes the refresh token when none is given', () => {
    storeTokens('access-1', 'refresh-1');
    storeTokens('access-2');

    expect(readStoredTokens()).toEqual({ access: 'access-2', refresh: '' });
  });
});

describe('shouldRefreshAccessToken', () => {
  it('is true only near expiry', () => {
    expect(shouldRefreshAccessToken(jwt(Math.floor(Date.now() / 1000) + 60 * 60))).toBe(false);
    expect(shouldRefreshAccessToken(jwt(Math.floor(Date.now() / 1000) + 60))).toBe(true);
    expect(shouldRefreshAccessToken('not-a-jwt')).toBe(false);
    expect(shouldRefreshAccessToken('')).toBe(false);
  });
});

describe('refreshAccessToken', () => {
  it('posts the refresh token, stores the rotated pair and notifies listeners', async () => {
    storeTokens('old-access', 'old-refresh');
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { access: 'new-access', refresh: 'new-refresh' },
    });
    const listener = vi.fn();
    const unsubscribe = onTokensRefreshed(listener);

    await expect(refreshAccessToken()).resolves.toBe('new-access');

    expect(post).toHaveBeenCalledWith(expect.stringContaining('/api/token/refresh/'), {
      refresh: 'old-refresh',
    });
    expect(readStoredTokens()).toEqual({ access: 'new-access', refresh: 'new-refresh' });
    expect(listener).toHaveBeenCalledWith('new-access', 'new-refresh');
    unsubscribe();
  });

  it('shares one request between concurrent calls', async () => {
    storeTokens('old-access', 'old-refresh');
    let resolveRequest: (value: unknown) => void = () => {};
    const post = vi.spyOn(axios, 'post').mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const first = refreshAccessToken();
    const second = refreshAccessToken();
    expect(post).toHaveBeenCalledTimes(1);

    resolveRequest({ data: { access: 'new-access', refresh: 'new-refresh' } });
    await expect(first).resolves.toBe('new-access');
    await expect(second).resolves.toBe('new-access');
  });

  it('uses a refresh token another tab rotated just before', async () => {
    storeTokens('old-access', 'old-refresh');
    const post = vi
      .spyOn(axios, 'post')
      .mockImplementationOnce(async () => {
        // Another tab renewed first and stored the rotated pair.
        storeTokens('other-access', 'other-refresh');
        throw new Error('401');
      })
      .mockResolvedValueOnce({ data: { access: 'new-access', refresh: 'new-refresh' } });

    await expect(refreshAccessToken()).resolves.toBe('new-access');

    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith(expect.any(String), { refresh: 'other-refresh' });
    expect(readStoredTokens()).toEqual({ access: 'new-access', refresh: 'new-refresh' });
  });

  it('returns null without a refresh token or when the refresh is refused', async () => {
    expect(await refreshAccessToken()).toBeNull();

    storeTokens('old-access', 'old-refresh');
    vi.spyOn(axios, 'post').mockRejectedValue(new Error('401'));
    expect(await refreshAccessToken()).toBeNull();
  });
});
