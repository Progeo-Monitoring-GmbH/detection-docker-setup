import { describe, expect, it } from 'vitest';

import {
  applyPermissionPreset,
  PERMISSION_GROUPS,
  selectedPermissionPreset,
} from './staffPermissions';

describe('staff permission presets', () => {
  it('covers every configured permission exactly once', () => {
    const codes = PERMISSION_GROUPS.flatMap((group) => group.permissions);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('applies only grantable preset permissions and preserves locked selections', () => {
    const group = PERMISSION_GROUPS.find(({ id }) => id === 'locations')!;
    const current = [
      'module_locations_django_edit',
      'module_locations_edit',
      'module_devices_enabled',
    ];

    expect(
      applyPermissionPreset(current, group, 'admin', [
        'module_locations_enabled',
        'module_locations_edit',
        'module_locations_selectable',
        'module_devices_enabled',
      ]),
    ).toEqual([
      'module_locations_django_edit',
      'module_devices_enabled',
      'module_locations_enabled',
      'module_locations_edit',
      'module_locations_selectable',
    ]);
  });

  it('marks a group custom when its selected permissions do not match a preset', () => {
    const group = PERMISSION_GROUPS.find(({ id }) => id === 'devices')!;
    expect(
      selectedPermissionPreset(
        ['module_devices_edit'],
        group,
        group.permissions,
      ),
    ).toBe('custom');
  });
});
