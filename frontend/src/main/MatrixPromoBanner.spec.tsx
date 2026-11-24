// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  user: { is_staff: false, is_superuser: false } as Record<string, unknown>,
  permissions: new Set<string>(),
  matrix: { user_id: '@a:chat', homeserver: 'https://chat', apps: {}, connected_at: null, primary: false } as Record<
    string,
    unknown
  > | null,
  gets: 0,
}));

vi.mock('../../hooks/CoreAuthProvider.tsx', () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock('../../hooks/usePermissions', () => ({
  default: () => ({ hasPermission: (code: string) => state.permissions.has(code), isLoading: false }),
}));
vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, _url: string, ok: (response: unknown) => void) => {
      state.gets += 1;
      ok({ data: { matrix: state.matrix } });
      return Promise.resolve();
    },
  },
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
// The setup dialog - not what this is about.
vi.mock('./MatrixSetupModal', () => ({ default: () => null }));

const { default: MatrixPromoBanner, DISMISS_KEY } = await import('./MatrixPromoBanner');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  state.user = { is_staff: false, is_superuser: false };
  state.permissions = new Set();
  state.matrix = { user_id: '@a:chat', homeserver: 'https://chat', apps: {}, connected_at: null, primary: false };
  state.gets = 0;
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = () => act(() => root.render(<MatrixPromoBanner />));
const banner = () => container.querySelector('[data-testid="matrix-promo"]');

describe('MatrixPromoBanner', () => {
  it('recommends the ProGeo chat to staff', () => {
    state.user = { is_staff: true, is_superuser: false };
    render();

    expect(banner()!.textContent).toContain('matrix_promo_title');
    expect(container.querySelector('[data-testid="matrix-promo-open"]')!.textContent).toContain('matrix_setup_open');
  });

  it('recommends it to customer admins', () => {
    state.permissions = new Set(['module_customer_admin_enabled']);
    render();

    expect(banner()).not.toBeNull();
  });

  it('is not shown to other users - nor asks for their profile', () => {
    state.permissions = new Set(['module_locations_enabled', 'module_locations_edit']);
    render();

    expect(banner()).toBeNull();
    expect(state.gets).toBe(0);
  });

  it('is not shown to staff viewing the portal as a normal user', () => {
    // viewAsUser: the user's staff flags are cleared (asNormalUser).
    state.user = { is_staff: false, is_superuser: false, view_as_user: true };
    render();

    expect(banner()).toBeNull();
  });

  it('is gone once the chat is the primary channel', () => {
    state.user = { is_staff: true };
    state.matrix = { ...state.matrix, primary: true };
    render();

    expect(banner()).toBeNull();
  });

  it('offers to use a connected chat for the notifications', () => {
    state.user = { is_staff: true };
    state.matrix = { ...state.matrix, connected_at: '2026-11-20T10:00:00Z' };
    render();

    expect(container.querySelector('[data-testid="matrix-promo-open"]')!.textContent).toContain('matrix_make_primary');
  });

  it('can be closed - remembered in this browser', () => {
    state.user = { is_staff: true };
    render();

    act(() => (container.querySelector('[data-testid="matrix-promo-dismiss"]') as HTMLButtonElement).click());

    expect(banner()).toBeNull();
    expect(window.localStorage.getItem(DISMISS_KEY)).toBe('1');
    act(() => root.unmount());
    root = createRoot(container);
    render();
    expect(banner()).toBeNull();
  });
});
