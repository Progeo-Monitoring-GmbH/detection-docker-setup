import { describe, expect, it } from 'vitest';

import {
  applyPermissionPreset,
  copyPermissions,
  grantablePermissionGroups,
  PERMISSION_GROUPS,
  selectedPermissionPreset,
} from './staffPermissions';

describe('grantablePermissionGroups', () => {
  const definitions = [
    { code: 'module_locations_enabled', label: 'Locations' },
    { code: 'module_locations_edit', label: 'Edit locations' },
    { code: 'module_backup_enabled', label: 'Backups' },
    { code: 'module_not_in_any_group', label: 'Something new' },
  ];

  it('shows only what the editor may grant - and no group without any', () => {
    const { shown, groups, ungrouped } = grantablePermissionGroups(
      definitions,
      ['module_locations_enabled'],
    );

    expect(shown.map((definition) => definition.code)).toEqual([
      'module_locations_enabled',
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].definitions.map((definition) => definition.code)).toEqual([
      'module_locations_enabled',
    ]);
    expect(ungrouped).toEqual([]);
  });

  it('lists a grantable permission of no group under "Other"', () => {
    expect(
      grantablePermissionGroups(definitions, ['module_not_in_any_group'])
        .ungrouped,
    ).toEqual([{ code: 'module_not_in_any_group', label: 'Something new' }]);
  });

  it('shows nothing at all when nothing can be granted', () => {
    expect(grantablePermissionGroups(definitions, [])).toEqual({
      shown: [],
      groups: [],
      ungrouped: [],
    });
  });
});

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

describe('copyPermissions', () => {
  const grantable = ['a', 'b', 'c'];

  it('takes the grantable permissions of the other user', () => {
    expect(copyPermissions(['a', 'x'], ['b', 'c'], grantable)).toEqual({
      permissions: ['x', 'b', 'c'],
      skipped: [],
    });
  });

  it('keeps what can not be granted and names what was skipped', () => {
    expect(copyPermissions(['x'], ['a', 'x', 'y'], grantable)).toEqual({
      permissions: ['x', 'a'],
      skipped: ['y'],
    });
  });
});
