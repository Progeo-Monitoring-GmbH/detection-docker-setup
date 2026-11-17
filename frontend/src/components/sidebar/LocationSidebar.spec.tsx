// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../hooks/CoreAuthProvider.tsx', () => ({ useAuth: () => ({}) }));
vi.mock('../../axiosConfig', () => ({ default: { perform_get: () => undefined } }));
vi.mock('../../main/access', () => ({
  useAccess: () => ({ can: () => true, hasPermission: () => false }),
  routeRule: (route: string) => route,
  portalItemRule: () => null,
}));
vi.mock('../../main/roleModel', () => ({ useProgeoRole: () => 'staff' }));
vi.mock('../../main/portalNav', () => ({ PORTAL_NAV_ITEMS: [], portalNavPath: () => '' }));
vi.mock('./SidebarShell', () => ({
  default: ({ children }: { children: (state: { collapsed: boolean }) => React.ReactNode }) => (
    <>{children({ collapsed: false })}</>
  ),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { default: LocationSidebar, selectedLocationParam, showsVerwaltungLink } = await import('./LocationSidebar');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
  container.querySelector(`[data-testid="sidebar-link"][data-test-key="${key}"]`)!.getAttribute('href');

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

    const link = container.querySelector('[data-testid="sidebar-link"][data-test-key="lageplan"]')!;
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
});
