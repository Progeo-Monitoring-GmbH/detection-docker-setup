// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({ loginAction: vi.fn() }));

vi.mock('../../../hooks/CoreAuthProvider', () => ({ useAuth: () => auth }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({
    t: (key, options) => (options ? `${key}:${JSON.stringify(options)}` : key),
    i18n: { language: 'de', changeLanguage: () => Promise.resolve() },
  }),
}));

const { default: LoginForm } = await import('./LoginForm');

let container;
let root;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  auth.loginAction.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const render = () =>
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginForm />
      </MemoryRouter>,
    );
  });
const byTestId = (id) => container.querySelector(`[data-testid="${id}"]`);
const submit = (form = 'login-form') =>
  act(async () => {
    byTestId(form).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
const tick = (ms) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe('LoginForm', () => {
  it('shows the wrong-credentials error', async () => {
    auth.loginAction.mockResolvedValue('failed');
    render();
    expect(byTestId('login-error')).toBeNull();

    await submit();

    expect(byTestId('login-error').textContent).toBe('login_failed');
    expect(byTestId('login-throttled')).toBeNull();
    expect(byTestId('login-submit').disabled).toBe(false);
  });

  it('counts the throttle wait down with the submit button disabled', async () => {
    auth.loginAction.mockResolvedValue({ retryAfter: 2 });
    render();

    await submit();

    const notice = byTestId('login-throttled');
    expect(notice.getAttribute('data-retry-after')).toBe('2');
    expect(notice.textContent).toBe('login_throttled:{"seconds":2}');
    expect(byTestId('login-error')).toBeNull();
    expect(byTestId('login-submit').disabled).toBe(true);

    tick(1000);
    expect(byTestId('login-throttled').getAttribute('data-retry-after')).toBe('1');
    expect(byTestId('login-throttled').textContent).toBe('login_throttled:{"seconds":1}');
    expect(byTestId('login-submit').disabled).toBe(true);

    tick(1000);
    expect(byTestId('login-throttled')).toBeNull();
    expect(byTestId('login-submit').disabled).toBe(false);
  });

  it('hides the last error while the next attempt runs', async () => {
    auth.loginAction.mockResolvedValueOnce('failed');
    render();
    await submit();
    expect(byTestId('login-error')).not.toBeNull();

    let finish;
    auth.loginAction.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await submit();
    expect(byTestId('login-error')).toBeNull();

    await act(async () => finish('failed'));
    expect(byTestId('login-error')).not.toBeNull();
  });

  it('keeps the 2FA step when the code check is throttled', async () => {
    auth.loginAction.mockResolvedValueOnce('otp_required');
    render();
    await submit();
    expect(byTestId('login-otp-form')).not.toBeNull();

    auth.loginAction.mockResolvedValueOnce({ retryAfter: 4 });
    await submit('login-otp-form');

    expect(byTestId('login-otp-form')).not.toBeNull();
    expect(byTestId('login-throttled').getAttribute('data-retry-after')).toBe('4');
    expect(byTestId('login-otp-submit').disabled).toBe(true);
  });
});
