// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ post: vi.fn(), answer: null as unknown }));
const auth = vi.hoisted(() => ({ loginWithTokens: vi.fn() }));

vi.mock('../axiosConfig', () => ({
  default: {
    perform_post: (
      _auth: unknown,
      url: string,
      body: unknown,
      ok: (response: unknown) => void,
      failed: (error: unknown) => void,
    ) => {
      api.post(url, body);
      if (api.answer instanceof Error) {
        failed(api.answer);
      } else {
        ok({ data: api.answer });
      }
    },
  },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => auth }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'de', changeLanguage: () => Promise.resolve() } }),
}));

const { default: MagicLinkLogin } = await import('./MagicLinkLogin');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.post.mockClear();
  auth.loginWithTokens.mockClear();
  api.answer = { access: 'A', refresh: 'R', forward: '/' };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = () =>
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/login/link/tok123']}>
        <Routes>
          <Route path="/login/link/:token" element={<MagicLinkLogin />} />
          <Route path="/account/invite/:token" element={<div data-testid="invite-page" />} />
          <Route path="/" element={<div data-testid="home" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const login = () => act(() => (byTestId('magic-link-login-submit') as HTMLButtonElement).click());

describe('MagicLinkLogin', () => {
  it('redeems the link only on the click and signs in', () => {
    render();
    expect(api.post).not.toHaveBeenCalled();

    login();

    expect(api.post).toHaveBeenCalledWith('/api/auth-support/login-link/exchange/', { token: 'tok123' });
    expect(auth.loginWithTokens).toHaveBeenCalledWith('A', 'R');
    expect(byTestId('home')).not.toBeNull();
  });

  it('sends an invitation to the password page - it never signs in by itself', () => {
    api.answer = Object.assign(new Error('400'), {
      response: {
        status: 400,
        data: { success: false, reason: 'password_setup_required', forward: '/account/invite/tok123' },
      },
    });
    render();

    login();

    expect(auth.loginWithTokens).not.toHaveBeenCalled();
    expect(byTestId('invite-page')).not.toBeNull();
  });
});
