import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProgeoRole } from './roleModel';

const mocks = vi.hoisted(() => ({
  user: null as unknown,
  permissions: new Set<string>(),
}));

vi.mock('../../hooks/CoreAuthProvider.tsx', () => ({
  useAuth: () => ({ user: mocks.user }),
}));
vi.mock('../../hooks/usePermissions', () => ({
  default: () => ({ hasPermission: (code: string) => mocks.permissions.has(code) }),
}));

beforeEach(() => {
  mocks.user = null;
  mocks.permissions.clear();
});

// useProgeoRole only composes the (mocked) auth/permission hooks, so it can be
// called directly without rendering a component.
describe('useProgeoRole', () => {
  it('maps staff users to progeo-admin', () => {
    mocks.user = { is_staff: true };
    expect(useProgeoRole()).toBe('progeo-admin');
  });

  it('lets staff win over the edit permission', () => {
    mocks.user = { is_staff: true };
    mocks.permissions.add('module_locations_edit');
    expect(useProgeoRole()).toBe('progeo-admin');
  });

  it('maps non-staff users with module_locations_edit to kundenadmin', () => {
    mocks.user = { is_staff: false };
    mocks.permissions.add('module_locations_edit');
    expect(useProgeoRole()).toBe('kundenadmin');
  });

  it('maps everyone else to nutzer', () => {
    mocks.user = { is_staff: false };
    mocks.permissions.add('module_locations_enabled');
    expect(useProgeoRole()).toBe('nutzer');
  });

  it('handles a missing user and a user without is_staff', () => {
    mocks.user = null;
    expect(useProgeoRole()).toBe('nutzer');
    mocks.user = {};
    expect(useProgeoRole()).toBe('nutzer');
  });
});
