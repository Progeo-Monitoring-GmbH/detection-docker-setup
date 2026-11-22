// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The login QR code in Mein Konto (module_profile_qr_code, /v1/user/qr-code/). */

const QR = 'data:image/png;base64,QQ==';

// What the backend answers, and what the profile asked it.
const api = vi.hoisted(() => ({
  profile: { username: 'erika', email: 'erika@progeo.com', language: 'de' } as Record<string, unknown>,
  qrFails: false,
  posts: [] as string[],
}));
vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: (response: unknown) => void) => {
      if (url === '/v1/user/profile/') {
        ok({ data: api.profile });
      }
      return Promise.resolve();
    },
    perform_post: (
      _auth: unknown,
      url: string,
      _data: unknown,
      ok: (response: unknown) => void,
      failed: (error: unknown) => void,
    ) => {
      api.posts.push(url);
      if (url === '/v1/user/qr-code/') {
        if (api.qrFails) {
          failed({ response: { status: 403, data: { reason: 'Missing required permissions' } } });
        } else {
          ok({ data: { success: true, qr: QR, created: true } });
        }
      }
      return Promise.resolve();
    },
  },
}));
// Stable objects, as the real hooks give: the profile reloads when `auth` changes.
const hooks = vi.hoisted(() => ({
  auth: { user: { username: 'erika' } },
  held: new Set<string>(),
  snackbar: { enqueueSnackbar: () => undefined },
  translation: { t: (key: string) => key, i18n: { changeLanguage: () => Promise.resolve() } },
}));
vi.mock('../../hooks/CoreAuthProvider.tsx', () => ({ useAuth: () => hooks.auth }));
vi.mock('../../hooks/usePermissions', () => ({
  default: () => ({ hasPermission: (code: string) => hooks.held.has(code) }),
}));
vi.mock('notistack', () => ({ useSnackbar: () => hooks.snackbar }));
vi.mock('react-i18next', () => ({ useTranslation: () => hooks.translation }));
const errors = vi.hoisted(() => [] as string[]);
vi.mock('../components/ui/Snackbar.jsx', () => ({
  errorReason: (error: { response?: { data?: { reason?: string } } }) => error?.response?.data?.reason || '',
  showErrorBar: (_enqueue: unknown, message: string) => errors.push(message),
  showInfoBar: () => undefined,
  showSuccessBar: () => undefined,
}));
// Not what this is about.
vi.mock('./TwoFactorSettings', () => ({ default: () => null }));
vi.mock('../components/ui/PhoneInput', () => ({ default: () => null }));

const { UserProfileModal } = await import('./UserProfile');

let container: HTMLDivElement;
let root: Root;

const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = () => byTestId('user-profile-qr-code-button') as HTMLButtonElement | null;
const image = () => byTestId('user-profile-qr-code-image') as HTMLImageElement | null;

const open = (profile: Record<string, unknown> = {}, permissions: string[] = ['module_profile_qr_code']) => {
  api.profile = { username: 'erika', email: 'erika@progeo.com', language: 'de', ...profile };
  hooks.held = new Set(permissions);
  act(() => root.render(<UserProfileModal show onHide={() => undefined} />));
};

const click = (element: HTMLElement | null) => {
  expect(element).not.toBeNull();
  act(() => element!.click());
};

beforeEach(() => {
  api.qrFails = false;
  api.posts.length = 0;
  errors.length = 0;
  hooks.auth = { user: { username: 'erika' } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('login QR code in the user profile', () => {
  it('is hidden without module_profile_qr_code', () => {
    open({ qr_code_exists: true }, ['module_profile_mail_edit']);

    expect(byTestId('user-profile-contact')).not.toBeNull(); // the profile itself is there
    expect(byTestId('user-profile-qr-code')).toBeNull();
    expect(button()).toBeNull();
  });

  it('offers "generieren" without a token, shows the code and then offers "zeigen"', () => {
    open({ qr_code_exists: false });

    expect(button()?.textContent).toContain('profile_qr_code_generate');
    expect(image()).toBeNull();
    expect(api.posts).toEqual([]); // nothing is created before the click

    click(button());

    expect(api.posts).toEqual(['/v1/user/qr-code/']);
    expect(image()?.getAttribute('src')).toBe(QR);
    expect(image()?.getAttribute('alt')).toBe('profile_qr_code_alt');
    expect(byTestId('user-profile-qr-code')?.textContent).toContain('profile_qr_code_hint');
    expect(button()?.textContent).toContain('profile_qr_code_hide');

    click(button()); // hide: no request, the token exists now

    expect(image()).toBeNull();
    expect(api.posts).toEqual(['/v1/user/qr-code/']);
    expect(button()?.textContent).toContain('profile_qr_code_show');
  });

  it('offers "zeigen" when the user already has a token', () => {
    open({ qr_code_exists: true });

    expect(button()?.textContent).toContain('profile_qr_code_show');
    expect(image()).toBeNull();

    click(button());

    expect(image()?.getAttribute('src')).toBe(QR);
  });

  it('shows an error and no code when the backend refuses', () => {
    api.qrFails = true;
    open({ qr_code_exists: false });

    click(button());

    expect(image()).toBeNull();
    expect(errors).toEqual(['profile_qr_code_error: Missing required permissions']);
    expect(button()?.textContent).toContain('profile_qr_code_generate');
    expect(button()?.disabled).toBe(false);
  });

  it('is hidden for the demo user', () => {
    hooks.auth = { user: { username: 'demo', is_demo: true } as { username: string } };
    open({ qr_code_exists: true });

    expect(byTestId('user-profile-contact')).not.toBeNull();
    expect(byTestId('user-profile-qr-code')).toBeNull();
  });
});
