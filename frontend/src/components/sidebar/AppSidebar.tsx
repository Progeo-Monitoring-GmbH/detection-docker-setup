import type { CSSProperties } from 'react';
import { Link, useLocation as useRouterLocation } from 'react-router';
import {
  Bell,
  Box,
  Broadcast,
  Calendar3,
  Database,
  FileEarmarkText,
  Gear,
  Geo,
  Hdd,
  Layers,
  Map,
  People,
  Terminal,
} from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../../hooks/usePermissions';
import SidebarShell, {
  SIDEBAR_ACTIVE_SHADOW,
  sidebarGroupLabelStyle,
  sidebarItemBaseStyle,
} from './SidebarShell';

type Item = {
  key: string;
  label: string;
  icon: typeof Geo;
  to: string;
  visible: boolean;
};

/**
 * General-purpose sidebar for every route that isn't the object/location
 * monitoring portal (that one has its own mockup-driven LocationSidebar).
 *
 * Visibility: staff see Locations, Staff Admin and Backup; everything else is
 * superuser-only. is_staff and is_superuser are separate roles - superusers
 * see every item, staff only the ones explicitly listed for them. Locations
 * and Backup additionally need their module permission (superusers pass
 * hasPermission automatically).
 */
const AppSidebar = () => {
  const auth = useAuth();
  const { t } = useTranslation();
  const { hasPermission, isAdmin: isSuperuser } = usePermissions();
  const routerLocation = useRouterLocation();

  const isStaffUser = Boolean(
    (auth?.user as { is_staff?: boolean } | null)?.is_staff,
  );

  const topItems: Item[] = [
    {
      key: 'location',
      label: t('sidebar_locations'),
      icon: Geo,
      to: '/location/overview/',
      visible: hasPermission('module_locations_enabled'),
    },
    {
      key: 'device',
      label: t('sidebar_devices'),
      icon: Hdd,
      to: '/device/overview',
      visible: isSuperuser,
    },
    {
      key: 'alarms',
      label: t('sidebar_alarms'),
      icon: Bell,
      to: '/alarms/',
      visible: isSuperuser,
    },
    {
      key: 'alarm-report',
      label: t('sidebar_reports'),
      icon: Calendar3,
      to: '/alarms/report/',
      visible: isSuperuser,
    },
  ];

  const adminItems: Item[] = [
    {
      key: 'staff',
      label: t('sidebar_staff_admin'),
      icon: People,
      to: '/staff/',
      visible: isStaffUser || isSuperuser,
    },
    {
      key: 'verwaltung',
      label: t('sidebar_object_management'),
      icon: Geo,
      to: '/verwaltung/',
      visible: isSuperuser,
    },
    {
      key: 'anlegen',
      label: t('sidebar_create_object'),
      icon: Layers,
      to: '/anlegen/',
      visible: isSuperuser,
    },
    {
      key: 'backup',
      label: t('sidebar_backup'),
      icon: Database,
      to: '/backup/1/overview/',
      visible: hasPermission('module_backup_enabled'),
    },
    {
      key: 'docker',
      label: t('sidebar_docker'),
      icon: Box,
      to: '/docker/',
      visible: isSuperuser,
    },
    {
      key: 'admin-panel',
      label: t('sidebar_admin_panel'),
      icon: Gear,
      to: '/admin/panel/',
      visible: isSuperuser,
    },
  ];
  const showAdminGroup = adminItems.some((item) => item.visible);

  const toolItems: Item[] = [
    {
      key: 'factory',
      label: t('sidebar_factory'),
      icon: Map,
      to: '/factory/',
      visible: isSuperuser,
    },
    {
      key: 'lageplan',
      label: t('sidebar_lageplan_wizard'),
      icon: Layers,
      to: '/lageplan/wizard/',
      visible: isSuperuser,
    },
    {
      key: 'map',
      label: t('sidebar_map'),
      icon: Geo,
      to: '/map/',
      visible: isSuperuser,
    },
    {
      key: 'legacy',
      label: t('sidebar_legacy_import'),
      icon: FileEarmarkText,
      to: '/legacy/import/',
      visible: isSuperuser,
    },
    {
      key: 'ws-debug',
      label: t('sidebar_ws_debug'),
      icon: Broadcast,
      to: '/ws-debug',
      visible: isSuperuser,
    },
    {
      key: 'dev',
      label: t('sidebar_dev'),
      icon: Terminal,
      to: '/dev',
      visible: isSuperuser,
    },
  ];
  const showToolsGroup = toolItems.some((item) => item.visible);

  const groupLabelStyle = sidebarGroupLabelStyle(true);

  const itemStyle = (active: boolean): CSSProperties => ({
    ...sidebarItemBaseStyle,
    gap: 11,
    color: 'var(--progeo-blue)',
    background: active ? 'var(--progeo-surface)' : 'transparent',
    boxShadow: active ? SIDEBAR_ACTIVE_SHADOW : 'none',
  });

  const isActive = (to: string) => {
    const prefix = to.endsWith('/') ? to : `${to}/`;
    return (
      routerLocation.pathname === to ||
      routerLocation.pathname.startsWith(prefix)
    );
  };

  const renderItem = (item: Item) => {
    if (!item.visible) {
      return null;
    }
    const Icon = item.icon;
    return (
      <Link key={item.key} to={item.to} style={itemStyle(isActive(item.to))}>
        <Icon size={17} style={{ flexShrink: 0 }} />
        <span
          style={{
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {item.label}
        </span>
      </Link>
    );
  };

  const navContent = (
    <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {topItems.map(renderItem)}

      {showAdminGroup && (
        <>
          <div style={groupLabelStyle}>{t('sidebar_group_admin')}</div>
          {adminItems.map(renderItem)}
        </>
      )}

      {showToolsGroup && (
        <>
          <div style={groupLabelStyle}>{t('sidebar_group_tools')}</div>
          {toolItems.map(renderItem)}
        </>
      )}
    </nav>
  );

  return (
    <SidebarShell
      width={220}
      toggleLabel={t('nav_menu_toggle')}
      closeLabel={t('nav_menu_close')}
    >
      {navContent}
    </SidebarShell>
  );
};

export default AppSidebar;
