// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { duplicateTestIds } from '../testIds';
import type { NotificationLocation } from './NotificationLocationsPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  rows: [] as NotificationLocation[],
  failPost: false,
}));
const hooks = vi.hoisted(() => ({
  auth: {},
  snackbar: { enqueueSnackbar: vi.fn() },
  translation: { t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key) },
}));

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: (response: unknown) => void) => {
      api.get(url);
      ok({ data: { locations: api.rows, counts: { disabled: 2, enabled: 5 } } });
    },
    perform_post: (
      _auth: unknown,
      url: string,
      body: { disabled: boolean },
      ok: (response: unknown) => void,
      fail: (error: unknown) => void,
    ) => {
      api.post(url, body);
      if (api.failPost) {
        fail(new Error('nope'));
        return;
      }
      const id = Number(/\/(\d+)\/toggle\/$/.exec(url)?.[1]);
      const row = api.rows.find((entry) => entry.id === id)!;
      ok({
        data: {
          location: { ...row, notifications_disabled: body.disabled },
          counts: body.disabled ? { disabled: 2, enabled: 5 } : { disabled: 1, enabled: 6 },
        },
      });
    },
  },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => hooks.auth }));
vi.mock('notistack', () => ({ useSnackbar: () => hooks.snackbar }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => hooks.translation,
}));

const { default: NotificationLocationsPanel } = await import('./NotificationLocationsPanel');

const ROW = (id: number, fields: Partial<NotificationLocation> = {}): NotificationLocation => ({
  id,
  name: `Halle ${id}`,
  project_id: 4700 + id,
  city: 'Köln',
  account_name: 'Kunde A',
  notifications_disabled: true,
  open_cases: 0,
  withheld_last_week: 0,
  ...fields,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // DataTable asks for the colour scheme; jsdom has no matchMedia.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  // ...and its pagination watches its width.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.get.mockClear();
  api.post.mockClear();
  hooks.snackbar.enqueueSnackbar.mockClear();
  api.failPost = false;
  api.rows = [ROW(1, { open_cases: 2, withheld_last_week: 7 }), ROW(2, { name: 'Lager Süd', account_name: 'Kunde B' })];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = () =>
  act(() => {
    root.render(
      <MemoryRouter>
        <NotificationLocationsPanel />
      </MemoryRouter>,
    );
  });

const switchOf = (id: number) =>
  container.querySelector<HTMLInputElement>(`[data-testid="notification-locations-switch"][data-test-key="${id}"]`)
  ?? container.querySelector<HTMLInputElement>(`#notification-location-switch-${id}`);

const linkKeys = () =>
  [...container.querySelectorAll('[data-testid="notification-locations-link"]')].map((link) =>
    link.getAttribute('data-test-key'),
  );

describe('NotificationLocationsPanel', () => {
  it('lists the switched-off locations with their counts and a switch per row', () => {
    render();

    expect(api.get).toHaveBeenCalledWith('/v1/notification-location/?state=disabled');
    expect(linkKeys()).toEqual(['1', '2']);
    expect(container.textContent).toContain('Halle 1');
    expect(container.textContent).toContain('#4701');
    expect(container.textContent).toContain('notification_locations_filter_disabled:{"count":2}');
    expect(switchOf(1)!.checked).toBe(false);
    expect(duplicateTestIds(container)).toEqual([]);
  });

  it('switches a location on in place and keeps the row', () => {
    render();

    act(() => switchOf(1)!.click());

    expect(api.post).toHaveBeenCalledWith('/v1/notification-location/1/toggle/', { disabled: false });
    expect(switchOf(1)!.checked).toBe(true);
    expect(linkKeys()).toEqual(['1', '2']);
    expect(container.textContent).toContain('notification_locations_filter_enabled:{"count":6}');
    expect(hooks.snackbar.enqueueSnackbar).toHaveBeenCalledTimes(1);
  });

  it('leaves the switch as it was when the toggle fails', () => {
    api.failPost = true;
    render();

    act(() => switchOf(2)!.click());

    expect(switchOf(2)!.checked).toBe(false);
    expect(switchOf(2)!.disabled).toBe(false);
  });

  it('filters by name, project and customer', () => {
    render();
    const search = container.querySelector<HTMLInputElement>('[data-testid="notification-locations-search"]')!;
    const type = (value: string) =>
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(search, value);
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });

    type('kunde b');
    expect(linkKeys()).toEqual(['2']);
    type('4701');
    expect(linkKeys()).toEqual(['1']);
  });
});
