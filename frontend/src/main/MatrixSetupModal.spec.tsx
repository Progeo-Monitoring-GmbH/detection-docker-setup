// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixAccount } from './MatrixSetupModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  connectedAt: null as string | null,
  answers: {} as Record<string, unknown>,
}));
const hooks = vi.hoisted(() => ({
  auth: {},
  snackbar: { enqueueSnackbar: vi.fn() },
  translation: { t: (key: string) => key },
}));

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: (response: unknown) => void) => {
      api.get(url);
      ok({ data: { connected_at: api.connectedAt } });
    },
    perform_post: (_auth: unknown, url: string, body: unknown, ok: (response: unknown) => void) => {
      api.post(url, body);
      ok({ data: api.answers[url] ?? {} });
    },
  },
}));
vi.mock('../../hooks/CoreAuthProvider.tsx', () => ({ useAuth: () => hooks.auth }));
vi.mock('notistack', () => ({ useSnackbar: () => hooks.snackbar }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => hooks.translation,
}));

const { default: MatrixSetupModal } = await import('./MatrixSetupModal');

const ACCOUNT: MatrixAccount = {
  user_id: '@kai:matrix.progeo.com',
  homeserver: 'matrix.progeo.com',
  connected_at: null,
  apps: {
    element_x: { link: 'https://mobile.element.io/element?account_provider=matrix.progeo.com', qr: 'data:x' },
    fluffychat: { link: 'https://fluffychat.im/', qr: 'data:y' },
  },
  download: { link: 'https://mobile.element.io/element', qr: 'data:download', stores: { ios: 'https://apps.apple.com/x' } },
  primary: false,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.get.mockClear();
  api.post.mockClear();
  api.connectedAt = null;
  api.answers = {
    '/v1/user/matrix/qr/': {
      link: 'https://mobile.element.io/element?login_hint=progeo-qr%3Atok',
      qr: 'data:image/png;base64,QR',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      valid_seconds: 600,
    },
    '/v1/user/matrix/primary/': { subscriptions: 3 },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => act(() => byTestId(id)!.click());

const render = (props: Partial<React.ComponentProps<typeof MatrixSetupModal>> = {}) =>
  act(() => {
    root.render(<MatrixSetupModal show onHide={() => {}} account={ACCOUNT} {...props} />);
  });

describe('MatrixSetupModal', () => {
  it('starts with the install step: animation, store link and download code', () => {
    render();
    expect(byTestId('matrix-setup-content-1')).not.toBeNull();
    expect(byTestId('matrix-setup-clip')!.getAttribute('poster')).toBe('/assets/tutorial/matrix-step-1-install.png');
    expect(byTestId('matrix-setup-store-ios')!.getAttribute('href')).toBe('https://apps.apple.com/x');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('shows a one-time login code and moves on once the app signed in', () => {
    const onConnected = vi.fn();
    render({ onConnected });
    click('matrix-setup-next-1');

    expect(api.post).toHaveBeenCalledWith('/v1/user/matrix/qr/', {});
    expect(byTestId('matrix-setup-login-qr')!.getAttribute('src')).toBe('data:image/png;base64,QR');
    expect(byTestId('matrix-setup-open-here')!.getAttribute('href')).toContain('login_hint=progeo-qr');

    api.connectedAt = '2026-11-15T10:00:00';
    act(() => vi.advanceTimersByTime(3100));

    expect(onConnected).toHaveBeenCalledWith('2026-11-15T10:00:00');
    expect(byTestId('matrix-setup-content-3')).not.toBeNull();
  });

  it('offers a new code once the old one expired', () => {
    render({ initialStep: 2 });
    act(() => vi.advanceTimersByTime(601_000));
    expect(byTestId('matrix-setup-login-qr')).toBeNull();
    click('matrix-setup-new-code');
    expect(api.post.mock.calls.filter(([url]) => url === '/v1/user/matrix/qr/')).toHaveLength(2);
  });

  it('sends the test message and makes Matrix the primary channel', () => {
    const onPrimary = vi.fn();
    render({ initialStep: 3, onPrimary });

    click('matrix-setup-test');
    expect(api.post).toHaveBeenCalledWith('/v1/user/matrix/test/', {});
    expect(byTestId('matrix-setup-test-sent')).not.toBeNull();

    click('matrix-setup-make-primary');
    expect(api.post).toHaveBeenCalledWith('/v1/user/matrix/primary/', {});
    expect(onPrimary).toHaveBeenCalled();
    expect(byTestId('matrix-setup-make-primary')).toBeNull();
  });
});
