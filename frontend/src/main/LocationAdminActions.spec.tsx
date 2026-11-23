// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The Django admin buttons of the portal header (staff, by permission). */

const hooks = vi.hoisted(() => ({
  user: { is_demo: false } as unknown,
  staff: true,
  permissions: new Set<string>(),
}));
vi.mock('../../hooks/CoreAuthProvider.tsx', () => ({ useAuth: () => ({ user: hooks.user }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./access', () => ({
  useAccess: () => ({
    isStaffOrSuperuser: hooks.staff,
    hasPermission: (code: string) => hooks.permissions.has(code),
  }),
}));

const { default: LocationAdminActions } = await import('./LocationAdminActions');

let container: HTMLDivElement;
let root: Root;
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = () => act(() => root.render(<LocationAdminActions locationId={4} />));

beforeEach(() => {
  hooks.user = { is_demo: false };
  hooks.staff = true;
  hooks.permissions = new Set(['module_locations_django_edit', 'module_locations_django_delete']);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('LocationAdminActions', () => {
  it('links staff to the Django admin - icons, the text as tooltip', () => {
    render();

    const edit = byTestId('location-portal-django-edit');
    expect(edit?.getAttribute('href')).toBe('/aadmin/progeo/progeolocation/4/change/');
    expect(edit?.getAttribute('title')).toBe('status_edit_location_django');
    expect(edit?.textContent).toBe('');
    expect(byTestId('location-portal-django-delete')?.getAttribute('href')).toBe(
      '/aadmin/progeo/progeolocation/4/delete/',
    );
  });

  it('shows only what the permissions allow', () => {
    hooks.permissions = new Set(['module_locations_django_edit']);
    render();

    expect(byTestId('location-portal-django-edit')).not.toBeNull();
    expect(byTestId('location-portal-django-delete')).toBeNull();
  });

  it.each([
    ['without a permission', () => (hooks.permissions = new Set())],
    ['for a customer', () => (hooks.staff = false)],
    ['for the demo user', () => (hooks.user = { is_demo: true })],
  ])('shows nothing %s', (_name, setUp) => {
    setUp();
    render();

    expect(byTestId('location-portal-admin')).toBeNull();
  });
});
