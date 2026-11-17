// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ post: vi.fn(), answers: {} as Record<string, unknown> }));
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
      const answer = api.answers[url];
      if (answer instanceof Error) {
        failed(answer);
      } else {
        ok({ data: answer });
      }
    },
  },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => auth }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'de', changeLanguage: () => Promise.resolve() } }),
}));

const { default: MigrationSetup } = await import('./MigrationSetup');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.post.mockClear();
  auth.loginWithTokens.mockClear();
  api.answers = {
    '/api/auth-support/migration/check/': { username: 'erika', first_name: 'Erika', email: 'erika@progeo.com' },
    '/api/auth-support/migration/confirm/': { access: 'A', refresh: 'R', forward: '/' },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = () =>
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/account/setup/tok123']}>
        <Routes>
          <Route path="/account/setup/:token" element={<MigrationSetup />} />
          <Route path="/" element={<div data-testid="home" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
const byTestId = (id: string) => container.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
const type = (id: string, value: string) =>
  act(() => {
    const input = byTestId(id)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const submit = () => act(() => byTestId('migration-setup-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

describe('MigrationSetup', () => {
  it('only checks the link on load and shows the user name', () => {
    render();
    expect(api.post.mock.calls.map(([url]) => url)).toEqual(['/api/auth-support/migration/check/']);
    expect(byTestId('migration-setup-username')!.value).toBe('erika');
  });

  it('sets the password and signs the user in', () => {
    render();
    type('migration-setup-password', 'Sehr-sicheres-Passwort-2026');
    type('migration-setup-repeat', 'Sehr-sicheres-Passwort-2026');
    submit();

    expect(api.post).toHaveBeenLastCalledWith('/api/auth-support/migration/confirm/', {
      token: 'tok123',
      password: 'Sehr-sicheres-Passwort-2026',
    });
    expect(auth.loginWithTokens).toHaveBeenCalledWith('A', 'R');
    expect(byTestId('home')).not.toBeNull();
  });

  it('catches different passwords before asking the server', () => {
    render();
    type('migration-setup-password', 'Sehr-sicheres-Passwort-2026');
    type('migration-setup-repeat', 'anders');
    submit();

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('access_verify_mismatch');
  });

  it('offers a login link when the link is no longer valid', () => {
    api.answers['/api/auth-support/migration/check/'] = new Error('400');
    render();
    expect(byTestId('migration-setup-invalid')).not.toBeNull();
    expect(byTestId('migration-setup-request-link')!.getAttribute('href')).toBe('/login/link');
  });
});
