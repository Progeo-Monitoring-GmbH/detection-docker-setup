export type PermissionGroup = {
  id: string;
  labelKey: string;
  permissions: string[];
  presets: Record<string, string[]>;
};

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    id: 'locations',
    labelKey: 'staff_permission_group_locations',
    permissions: [
      'module_locations_enabled',
      'module_locations_edit',
      'module_locations_delete',
      'module_locations_selectable',
      'module_locations_mergable',
      'module_locations_django_edit',
      'module_locations_django_delete',
    ],
    presets: {
      none: [],
      viewer: ['module_locations_enabled'],
      manager: [
        'module_locations_enabled',
        'module_locations_edit',
        'module_locations_selectable',
      ],
      admin: [
        'module_locations_enabled',
        'module_locations_edit',
        'module_locations_delete',
        'module_locations_selectable',
        'module_locations_mergable',
      ],
    },
  },
  {
    id: 'devices',
    labelKey: 'staff_permission_group_devices',
    permissions: [
      'module_devices_enabled',
      'module_devices_edit',
      'module_devices_delete',
      'module_devices_provision',
      'module_devices_commands',
    ],
    presets: {
      none: [],
      viewer: ['module_devices_enabled'],
      operator: [
        'module_devices_enabled',
        'module_devices_edit',
        'module_devices_commands',
      ],
      admin: [
        'module_devices_enabled',
        'module_devices_edit',
        'module_devices_delete',
        'module_devices_provision',
        'module_devices_commands',
      ],
    },
  },
  {
    id: 'monitoring',
    labelKey: 'staff_permission_group_monitoring',
    permissions: ['module_measurements_enabled', 'module_imei_enabled'],
    presets: {
      none: [],
      measurements: ['module_measurements_enabled'],
      full: ['module_measurements_enabled', 'module_imei_enabled'],
    },
  },
  {
    id: 'administration',
    labelKey: 'staff_permission_group_administration',
    permissions: [
      'module_admin_enabled',
      'module_admin_storage',
      'module_admin_lageplan_export',
      'module_admin_logs',
      'module_admin_staff_enabled',
      'module_admin_insights',
      'module_admin_screen_review',
      'module_admin_panel',
      'module_admin_thresholds',
      'module_backup_enabled',
      'module_backup_delete',
    ],
    presets: {
      none: [],
      admin: [
        'module_admin_enabled',
        'module_admin_storage',
        'module_admin_lageplan_export',
        'module_admin_logs',
        'module_admin_staff_enabled',
        'module_admin_insights',
        'module_admin_screen_review',
        'module_admin_panel',
        'module_admin_thresholds',
        'module_backup_enabled',
      ],
    },
  },
  {
    id: 'users',
    labelKey: 'staff_permission_group_users',
    permissions: [
      'module_mini_admin_enabled',
      'module_user_add',
      'module_user_invitable',
      'module_user_disability',
      'module_user_erasability',
      'module_user_revokable',
      'module_user_copy_permissions',
    ],
    presets: {
      none: [],
      viewer: ['module_user_invitable'],
      manager: [
        'module_mini_admin_enabled',
        'module_user_add',
        'module_user_invitable',
        'module_user_erasability',
      ],
      admin: [
        'module_mini_admin_enabled',
        'module_user_add',
        'module_user_invitable',
        'module_user_disability',
        'module_user_erasability',
        'module_user_revokable',
      ],
    },
  },
  {
    id: 'notifications',
    labelKey: 'staff_permission_group_notifications',
    permissions: [
      'module_notifications_enabled',
      'module_notifications_edit',
      'module_notifications_add',
    ],
    presets: {
      none: [],
      viewer: ['module_notifications_enabled'],
      manager: [
        'module_notifications_enabled',
        'module_notifications_edit',
        'module_notifications_add',
      ],
    },
  },
  {
    id: 'interfaces',
    labelKey: 'staff_permission_group_interfaces',
    permissions: [
      'module_interface_enabled',
      'module_interface_smtp_enabled',
      'module_interface_smtp_edit',
      'module_interface_modbus_enabled',
      'module_interface_modbus_edit',
      'module_interface_sms_enabled',
      'module_interface_sms_edit',
    ],
    presets: {
      none: [],
      viewer: [
        'module_interface_enabled',
        'module_interface_smtp_enabled',
        'module_interface_modbus_enabled',
        'module_interface_sms_enabled',
      ],
      manager: [
        'module_interface_enabled',
        'module_interface_smtp_enabled',
        'module_interface_smtp_edit',
        'module_interface_modbus_enabled',
        'module_interface_modbus_edit',
        'module_interface_sms_enabled',
        'module_interface_sms_edit',
      ],
    },
  },
  {
    id: 'other',
    labelKey: 'staff_permission_group_other',
    permissions: [
      'module_navbar_enabled',
      'module_docker_enabled',
      'module_testsuite_enabled',
      'module_demo_enabled',
      'module_profile_mail_edit',
      'module_profile_qr_code',
      'module_escalations_enabled',
      'module_reports_enabled',
      'module_alarms_enabled',
    ],
    presets: {
      none: [],
      basic: ['module_navbar_enabled', 'module_profile_mail_edit'],
      full: [
        'module_navbar_enabled',
        'module_profile_mail_edit',
        'module_testsuite_enabled',
        'module_demo_enabled',
        'module_docker_enabled',
      ],
    },
  },
];

export const applyPermissionPreset = (
  current: string[],
  group: PermissionGroup,
  preset: string,
  grantableCodes: string[],
): string[] => {
  const groupCodes = new Set(group.permissions);
  const grantable = new Set(grantableCodes);
  const presetCodes = group.presets[preset] ?? [];
  return [
    ...current.filter((code) => !groupCodes.has(code) || !grantable.has(code)),
    ...presetCodes.filter(
      (code) => groupCodes.has(code) && grantable.has(code),
    ),
  ];
};

export const selectedPermissionPreset = (
  current: string[],
  group: PermissionGroup,
  grantableCodes: string[],
): string => {
  const groupCodes = new Set(group.permissions);
  const grantable = new Set(grantableCodes);
  const selected = new Set(
    current.filter((code) => groupCodes.has(code) && grantable.has(code)),
  );
  const matchingPreset = Object.entries(group.presets).find(([, codes]) => {
    const expected = new Set(codes.filter((code) => grantable.has(code)));
    return (
      selected.size === expected.size &&
      [...selected].every((code) => expected.has(code))
    );
  });
  return matchingPreset?.[0] ?? 'custom';
};

/**
 * "Berechtigungen übernehmen von": the permissions of `source` (another
 * user) for every code the editor may grant - the others stay as they are
 * (the backend would refuse them anyway). `skipped`: what `source` holds
 * but differs here and can't be granted.
 */
export const copyPermissions = (
  current: string[],
  source: string[],
  grantableCodes: string[],
): { permissions: string[]; skipped: string[] } => {
  const grantable = new Set(grantableCodes);
  const has = new Set(current);
  return {
    permissions: [
      ...current.filter((code) => !grantable.has(code)),
      ...source.filter((code) => grantable.has(code)),
    ],
    skipped: source.filter((code) => !grantable.has(code) && !has.has(code)),
  };
};
