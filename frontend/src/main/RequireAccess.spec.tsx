// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  permissions: {} as Record<string, boolean>,
  /** Answers of the following requests, before `permissions` (granted meanwhile). */
  sequence: [] as Record<string, boolean>[],
  calls: 0,
  fail: false,
  auth: {
    token: 'token-1',
    user: { user_id: 5, is_staff: false, is_superuser: false },
    location: '/location/overview/',
    navigate: () => undefined,
  },
}));

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (
      _auth: unknown,
      _url: string,
      ok: (response: unknown) => void,
      fail: (error: unknown) => void,
    ) => {
      state.calls += 1;
      if (state.fail) {
        fail(new Error('down'));
      } else {
        const permissions = state.sequence.shift() ?? state.permissions;
        ok({
          data: {
            permissions,
            enabled: Object.keys(permissions).filter(
              (code) => permissions[code],
            ),
          },
        });
      }
      return Promise.resolve();
    },
  },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => state.auth }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { default: RequireAccess } = await import('./RequireAccess');
const { routeRule } = await import('./access');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  state.sequence = [];
  state.calls = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = async (token: string) => {
  state.auth = { ...state.auth, token };
  await act(async () => {
    root.render(
      <MemoryRouter>
        <RequireAccess rule={routeRule('/location/overview/')}>
          <div data-testid="page">objects</div>
        </RequireAccess>
      </MemoryRouter>,
    );
  });
};

describe('RequireAccess on /location/overview/', () => {
  it('lets a user with the permission in', async () => {
    state.permissions = { module_locations_enabled: true };
    state.fail = false;
    await render('token-locations');

    expect(container.querySelector('[data-testid="page"]')).not.toBeNull();
  });

  it('keeps a customer without the permission out - after asking once more', async () => {
    state.permissions = { module_devices_enabled: true };
    state.fail = false;
    await render('token-plain');

    expect(
      container.querySelector('[data-testid="require-access-denied"]'),
    ).not.toBeNull();
    expect(state.calls).toBe(2);
  });

  it('lets in a user granted the role after the permissions were loaded', async () => {
    // Loaded at login without it; granted since - the recheck finds it.
    state.sequence = [{ module_devices_enabled: true }];
    state.permissions = {
      module_devices_enabled: true,
      module_locations_enabled: true,
    };
    state.fail = false;
    await render('token-granted-later');

    expect(container.querySelector('[data-testid="page"]')).not.toBeNull();
  });

  it('shows a load error with a retry, not "no access", when the permissions fail', async () => {
    state.permissions = { module_locations_enabled: true };
    state.fail = true;
    await render('token-down');

    expect(
      container.querySelector('[data-testid="require-access-denied"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="require-access-error"]'),
    ).not.toBeNull();

    state.fail = false;
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="require-access-retry"]',
        ) as HTMLElement
      ).click();
    });
    expect(container.querySelector('[data-testid="page"]')).not.toBeNull();
  });
});
