// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  location: {
    id: 5,
    project_id: 4711,
    name: 'Parkhaus Nord',
    address: 'Hauptstraße 1',
    plz: '12345',
    city: 'Musterstadt',
    project_type: 10,
  } as Record<string, unknown>,
  staff: true,
  // An HTTP status the location request fails with (null: it loads).
  errorStatus: null as number | null,
  enqueue: vi.fn(),
}));

vi.mock('react-router', () => ({
  useParams: () => ({ id: '5' }),
  Outlet: () => <div data-testid="outlet" />,
  Link: ({ to, children, ...rest }: { to: string; children: unknown }) => (
    <a href={to} {...rest}>
      {children as never}
    </a>
  ),
}));
vi.mock('../../hooks/CoreAuthProvider.tsx', () => ({ useAuth: () => ({ user: {} }) }));
vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: state.enqueue }) }));
vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (
      _auth: unknown,
      _url: string,
      ok: (response: unknown) => void,
      fail: (error: unknown) => void,
    ) =>
      state.errorStatus == null
        ? ok({ data: state.location })
        : fail({ message: 'x', response: { status: state.errorStatus, data: {} } }),
  },
}));
vi.mock('./favorites', () => ({ isStaffUser: () => state.staff }));
// The shell's other parts don't matter here.
vi.mock('../components/sidebar/LocationSidebar', () => ({ default: () => null }));
vi.mock('../components/topbar/TopBar', () => ({ default: () => null }));
vi.mock('./EscalationBanner', () => ({ default: () => null }));
vi.mock('./FavoritesBar', () => ({ default: () => null }));
vi.mock('./LocationGroupBar', () => ({ default: () => null }));
vi.mock('./ImpersonationBanner', () => ({ default: () => null }));
vi.mock('./FavoriteStar', () => ({ default: () => <span data-testid="favorite-star" /> }));

const { default: LocationPortalLayout } = await import('./LocationPortalLayout');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  state.staff = true;
  state.errorStatus = null;
  state.enqueue.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const title = () => container.querySelector('[data-testid="portal-location-title"]');

describe('LocationPortalLayout', () => {
  it('names the object next to its star - with project number, product and address', () => {
    act(() => root.render(<LocationPortalLayout />));
    expect(container.querySelector('[data-testid="favorite-star"]')).not.toBeNull();
    const lines = [...title()!.children].map((line) => line.textContent);
    expect(lines[0]).toBe('Parkhaus Nord');
    expect(lines[1]).toMatch(/^#4711 · \S/);
    expect(lines[2]).toBe('Hauptstraße 1, 12345 Musterstadt');
  });

  it('names the object for customers too - with their own star', () => {
    state.staff = false;
    act(() => root.render(<LocationPortalLayout />));
    expect(container.querySelector('[data-testid="favorite-star"]')).not.toBeNull();
    expect(title()!.textContent).toContain('Parkhaus Nord');
  });

  it('falls back to the project number without a name, and leaves out what is missing', () => {
    state.location = { id: 5, project_id: 4711, name: null };
    act(() => root.render(<LocationPortalLayout />));
    expect([...title()!.children].map((line) => line.textContent)).toEqual(['4711', '#4711']);
  });

  it('shows the outlet, not the no-access notice, for a location the user may see', () => {
    act(() => root.render(<LocationPortalLayout />));
    expect(container.querySelector('[data-testid="outlet"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="location-no-access"]')).toBeNull();
  });

  it.each([403, 404])('shows the no-access notice instead of the tabs on %i', (status) => {
    state.errorStatus = status;
    act(() => root.render(<LocationPortalLayout />));
    expect(container.querySelector('[data-testid="location-no-access"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="outlet"]')).toBeNull();
    expect(container.querySelector('[data-testid="location-portal-loading"]')).toBeNull();
    expect(container.querySelector('[data-testid="portal-location-title"]')).toBeNull();
    expect(container.querySelector('[data-testid="location-no-access-home"]')?.getAttribute('href')).toBe('/');
  });

  it('toasts a 404 itself - a 403 gets its toast from axiosConfig', () => {
    state.errorStatus = 404;
    act(() => root.render(<LocationPortalLayout />));
    expect(state.enqueue).toHaveBeenCalledTimes(1);
    expect(state.enqueue.mock.calls[0][1]).toEqual({ variant: 'error' });
  });

  it('keeps the tabs for other errors (only a toast)', () => {
    state.errorStatus = 500;
    act(() => root.render(<LocationPortalLayout />));
    expect(container.querySelector('[data-testid="location-no-access"]')).toBeNull();
    expect(container.querySelector('[data-testid="outlet"]')).not.toBeNull();
    expect(state.enqueue).toHaveBeenCalledTimes(1);
  });
});
