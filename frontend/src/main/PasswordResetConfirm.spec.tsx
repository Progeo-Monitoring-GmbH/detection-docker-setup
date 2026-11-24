// @vitest-environment jsdom
// PasswordResetConfirm and VerifyAccess on the shared TokenPasswordPage parts:
// the link check on load, the password check, the page's own 2FA failures and
// the shared ones (rule errors, expired link, too many tries).
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
      if (answer && typeof answer === 'object' && 'response' in answer) {
        failed(answer);
      } else if (answer === undefined) {
        failed({ response: { status: 404, data: {} } });
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

const { default: PasswordResetConfirm } = await import('./PasswordResetConfirm');
const { default: VerifyAccess } = await import('./VerifyAccess');

const RESET_CHECK = '/api/auth-support/password-reset/check/';
const RESET_CONFIRM = '/api/auth-support/password-reset/confirm/';
const VERIFY_CHECK = '/api/auth-support/access-requests/verify/check/';
const VERIFY = '/api/auth-support/access-requests/verify/';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.post.mockClear();
  auth.loginWithTokens.mockClear();
  api.answers = {
    [RESET_CHECK]: { username: 'erika@progeo.com', first_name: 'Erika' },
    [RESET_CONFIRM]: { access: 'A', refresh: 'R', forward: '/location/overview/' },
    [VERIFY_CHECK]: { email: 'max@progeo.com', first_name: 'Max' },
    [VERIFY]: { access: 'A', refresh: 'R' },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (path: string) =>
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/password/reset/:token" element={<PasswordResetConfirm />} />
          <Route path="/access/verify/:token" element={<VerifyAccess />} />
          <Route path="/location/overview/" element={<div data-testid="overview" />} />
          <Route path="*" element={<div data-testid="elsewhere" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
const byTestId = (id: string) => container.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
const errorsOf = (prefix: string) =>
  [...container.querySelectorAll(`[data-testid="${prefix}-error"]`)].map((node) => node.textContent);
const type = (id: string, value: string) =>
  act(() => {
    const input = byTestId(id)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const submit = (prefix: string) =>
  act(() => byTestId(`${prefix}-form`)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
const fill = (prefix: string, password: string, repeat = password) => {
  type(`${prefix}-password`, password);
  type(`${prefix}-repeat`, repeat);
};

describe('PasswordResetConfirm', () => {
  it('checks the link on load and shows the account read-only', () => {
    render('/password/reset/tok1');
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith(RESET_CHECK, { token: 'tok1' });
    expect(byTestId('password-reset-username')!.value).toBe('erika@progeo.com');
    expect(byTestId('password-reset-username')!.readOnly).toBe(true);
    expect(byTestId('password-reset-otp')).not.toBeNull();
  });

  it('asks no code for a change link from Mein Konto of a user without 2FA', () => {
    api.answers[RESET_CHECK] = { username: 'erika@progeo.com', first_name: 'Erika', otp_required: false };
    render('/password/reset/tok2');

    expect(byTestId('password-reset-otp')).toBeNull();
    fill('password-reset', 'Secret-123');
    submit('password-reset');

    expect(api.post).toHaveBeenCalledWith(RESET_CONFIRM, { token: 'tok2', otp: '', password: 'Secret-123' });
    expect(auth.loginWithTokens).toHaveBeenCalledWith('A', 'R');
  });

  it('refuses two different passwords without asking the server', () => {
    render('/password/reset/tok1');
    fill('password-reset', 'Secret-123', 'Secret-124');
    submit('password-reset');
    expect(errorsOf('password-reset')).toEqual(['access_verify_mismatch']);
    expect(api.post).not.toHaveBeenCalledWith(RESET_CONFIRM, expect.anything());
  });

  it('sets the password with the code, logs in and follows an internal forward', () => {
    render('/password/reset/tok1');
    fill('password-reset', 'Secret-123');
    type('password-reset-otp', ' 123456 ');
    submit('password-reset');
    expect(api.post).toHaveBeenCalledWith(RESET_CONFIRM, { token: 'tok1', otp: '123456', password: 'Secret-123' });
    expect(auth.loginWithTokens).toHaveBeenCalledWith('A', 'R');
    expect(byTestId('overview')).not.toBeNull();
  });

  it('never follows an external forward', () => {
    api.answers[RESET_CONFIRM] = { access: 'A', refresh: 'R', forward: '//evil.example/x' };
    render('/password/reset/tok1');
    fill('password-reset', 'Secret-123');
    type('password-reset-otp', '123456');
    submit('password-reset');
    expect(byTestId('elsewhere')).not.toBeNull();
  });

  it('clears a wrong code and shows its own 2FA message', () => {
    api.answers[RESET_CONFIRM] = { response: { status: 400, data: { reason: 'otp_invalid' } } };
    render('/password/reset/tok1');
    fill('password-reset', 'Secret-123');
    type('password-reset-otp', '000000');
    submit('password-reset');
    expect(errorsOf('password-reset')).toEqual(['login_otp_invalid']);
    expect(byTestId('password-reset-otp')!.value).toBe('');
  });

  it('shows the password rules and too many tries, and the expired-link page', () => {
    api.answers[RESET_CONFIRM] = { response: { status: 400, data: { reason: 'password', errors: ['too short'] } } };
    render('/password/reset/tok1');
    fill('password-reset', 'x');
    type('password-reset-otp', '123456');
    submit('password-reset');
    expect(errorsOf('password-reset')).toEqual(['too short']);

    api.answers[RESET_CONFIRM] = { response: { status: 429, data: {} } };
    submit('password-reset');
    expect(errorsOf('password-reset')).toEqual(['auth_too_many_requests']);

    api.answers[RESET_CONFIRM] = { response: { status: 400, data: { reason: 'invalid_token' } } };
    submit('password-reset');
    expect(byTestId('password-reset-invalid')).not.toBeNull();
    expect(byTestId('password-reset-request-new')).not.toBeNull();
  });

  it('shows the invalid page when the check fails', () => {
    delete api.answers[RESET_CHECK];
    render('/password/reset/bad');
    expect(byTestId('password-reset-invalid')).not.toBeNull();
    expect(byTestId('password-reset-form')).toBeNull();
  });
});

describe('VerifyAccess', () => {
  it('shows the address, has no code field and falls back to its own error', () => {
    api.answers[VERIFY] = { response: { status: 500, data: {} } };
    render('/access/verify/tok2');
    expect(api.post).toHaveBeenCalledWith(VERIFY_CHECK, { token: 'tok2' });
    expect(byTestId('verify-access-email')!.value).toBe('max@progeo.com');
    expect(byTestId('verify-access-otp')).toBeNull();
    fill('verify-access', 'Secret-123');
    submit('verify-access');
    expect(api.post).toHaveBeenCalledWith(VERIFY, { token: 'tok2', password: 'Secret-123' });
    expect(errorsOf('verify-access')).toEqual(['access_verify_error']);
    // The button is usable again after a failure.
    expect(byTestId('verify-access-submit')!.hasAttribute('disabled')).toBe(false);
  });
});
