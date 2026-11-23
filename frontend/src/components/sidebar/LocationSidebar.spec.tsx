// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../hooks/CoreAuthProvider.tsx', () => ({ useAuth: () => ({}) }));
// Locations /v1/location/<id>/ answers for (the others: no access).
const api = vi.hoisted(() => ({ locations: new Map<number, { id: number; name: string }>(), urls: [] as string[] }));
vi.mock('../../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: (response: unknown) => void, fail: (error: unknown) => void) => {
      api.urls.push(url);
      const id = Number(/^\/v1\/location\/(\d+)\/$/.exec(url)?.[1]);
      if (id) {
        const location = api.locations.get(id);
        if (location) {
          ok({ data: location });
        } else {
          fail({ response: { status: 404 } });
        }
      }
    },
  },
}));
vi.mock('../../main/access', () => ({
  useAccess: () => ({ can: () => true, hasPermission: () => false }),
  routeRule: (route: string) => route,
  portalItemRule: () => null,
  CUSTOMER_ADMIN: () => false,
}));
vi.mock('../../main/roleModel', () => ({ useProgeoRole: () => 'staff' }));
vi.mock('../../main/portalNav', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  PORTAL_NAV_ITEMS: [{ key: 'status', segment: 'status', labelKey: 'nav_status', icon: 'M0 0' }],
}));
vi.mock('./SidebarShell', () => ({
  default: ({
    children,
  }: {
    children: (state: { collapsed: boolean }) => React.ReactNode;
  }) => <>{children({ collapsed: false })}</>,
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const {
  default: LocationSidebar,
  selectedLocationParam,
  showsVerwaltungLink,
} = await import('./LocationSidebar');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  api.locations.clear();
  api.urls = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (url: string, locationId: number | null = null) =>
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <LocationSidebar locationId={locationId} />
      </MemoryRouter>,
    );
  });

const href = (key: string) =>
  container
    .querySelector(`[data-testid="sidebar-link"][data-test-key="${key}"]`)!
    .getAttribute('href');

describe('LocationSidebar carries the selected location', () => {
  it('takes ?location= to the device overview and the Lageplan wizard', () => {
    render('/device/overview?location=42');

    expect(href('device')).toBe('/device/overview?location=42');
    expect(href('lageplan')).toBe('/site-plan/wizard/?location=42');
    // Other modules stay plain.
    expect(href('map')).toBe('/map/');
    expect(href('device-statistics')).toBe('/device/statistics/');
  });

  it('marks the page active although its link carries the location', () => {
    render('/site-plan/wizard/?location=7&plan=3');

    const link = container.querySelector(
      '[data-testid="sidebar-link"][data-test-key="lageplan"]',
    )!;
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(href('device')).toBe('/device/overview?location=7');
  });

  it('carries the open portal location when the URL has no ?location=', () => {
    render('/location/12/status', 12);

    expect(href('device')).toBe('/device/overview?location=12');
  });

  it('carries nothing without a selected location', () => {
    render('/map/');

    expect(href('device')).toBe('/device/overview');
    expect(href('lageplan')).toBe('/site-plan/wizard/');
  });

  it('ignores anything but a location pk', () => {
    expect(selectedLocationParam('?location=12abc', null)).toBeNull();
    expect(selectedLocationParam('?location=', 5)).toBe('5');
    expect(selectedLocationParam('?location=9', 5)).toBe('9');
  });
});

describe('showsVerwaltungLink', () => {
  it('always shows the link to object managers', () => {
    expect(showsVerwaltungLink(true, null)).toBe(true);
    expect(showsVerwaltungLink(true, 1)).toBe(true);
  });

  it('hides the object list from users with a single location', () => {
    expect(showsVerwaltungLink(false, null)).toBe(false);
    expect(showsVerwaltungLink(false, 0)).toBe(false);
    expect(showsVerwaltungLink(false, 1)).toBe(false);
    expect(showsVerwaltungLink(false, 2)).toBe(true);
  });

  it('always shows the overview to staff who may open it', () => {
    expect(showsVerwaltungLink(false, 0, true)).toBe(true);
    expect(showsVerwaltungLink(false, null, true)).toBe(true);
  });
});

describe('LocationSidebar with ?location= outside the portal', () => {
  const statusLink = () =>
    container.querySelector('[data-testid="sidebar-link"][data-test-key="status"]');

  it("shows the location's links on a page that selects it by ?location=", () => {
    api.locations.set(1181, { id: 1181, name: 'Halle 1181' });
    render('/device/overview?location=1181');

    expect(statusLink()?.getAttribute('href')).toBe('/location/1181/status');
    expect(container.textContent).toContain('Halle 1181');
  });

  it('shows no location links for a location the user cannot open', () => {
    render('/device/overview?location=77');

    expect(api.urls).toContain('/v1/location/77/');
    expect(statusLink()).toBeNull();
  });

  it('shows no location links without ?location=', () => {
    render('/device/overview');

    expect(statusLink()).toBeNull();
    expect(api.urls.some((url) => /^\/v1\/location\/\d+\/$/.test(url))).toBe(false);
  });
});
