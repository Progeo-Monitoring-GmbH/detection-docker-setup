// @vitest-environment jsdom
import axios from 'axios';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshAccessToken, storeTokens } from '../src/tokenRefresh';
import CoreAuthProvider, { useAuth, type AuthContextType } from './CoreAuthProvider';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** An unsigned JWT - jwtDecode doesn't check the signature. */
const jwt = (claims: Record<string, unknown>) => {
  const part = (value: object) =>
    btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.sig`;
};

const hourFromNow = () => Math.floor(Date.now() / 1000) + 3600;
const accessFor = (userId: number, jti: string) =>
  jwt({ user_id: userId, is_staff: false, is_superuser: false, jti, exp: hourFromNow() });

let container: HTMLDivElement;
let root: Root;
const seen: AuthContextType[] = [];

const Probe = () => {
  seen.push(useAuth());
  return null;
};

beforeEach(() => {
  seen.length = 0;
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const mount = async () => {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <CoreAuthProvider>
          <Probe />
        </CoreAuthProvider>
      </MemoryRouter>,
    );
  });
};

const renewTo = async (access: string, refresh: string) => {
  vi.spyOn(axios, 'post').mockResolvedValue({ data: { access, refresh } });
  await act(async () => {
    await refreshAccessToken();
  });
};

describe('CoreAuthProvider token renewal', () => {
  it('keeps the auth object of the same session - views do not load again', async () => {
    storeTokens(accessFor(5, 'a'), 'refresh-a');
    await mount();
    const before = seen[seen.length - 1];
    expect(before.user?.['user_id' as keyof typeof before.user]).toBe(5);

    const renewed = accessFor(5, 'b');
    await renewTo(renewed, 'refresh-b');

    const after = seen[seen.length - 1];
    expect(after).toBe(before);
    // Still the current tokens for whoever reads them.
    expect(after.token).toBe(renewed);
    expect(after.refreshToken).toBe('refresh-b');
  });

  it('gives a new auth object when the tokens belong to another user', async () => {
    storeTokens(accessFor(5, 'a'), 'refresh-a');
    await mount();
    const before = seen[seen.length - 1];

    await renewTo(accessFor(6, 'c'), 'refresh-c');

    const after = seen[seen.length - 1];
    expect(after).not.toBe(before);
    expect(after.user?.['user_id' as keyof typeof after.user]).toBe(6);
  });
});
