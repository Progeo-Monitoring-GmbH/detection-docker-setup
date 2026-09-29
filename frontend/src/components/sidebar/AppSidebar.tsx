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
 * A faithful 1:1 port of the retired Navbar.jsx's item list/permission
 * gates - nothing invented, except a "Devices" entry point that Navbar.jsx
 * never had despite the route already existing.
 */
const AppSidebar = () => {
  const auth = useAuth();
  const { hasPermission } = usePermissions();
  const routerLocation = useRouterLocation();


  const isStaffUser = Boolean((auth?.user as { is_staff?: boolean } | null)?.is_staff);

  const topItems: Item[] = [
    { key: 'location', label: 'Locations', icon: Geo, to: '/location/overview/', visible: hasPermission('module_locations_enabled') },
    { key: 'device', label: 'Devices', icon: Hdd, to: '/device/overview', visible: hasPermission('module_devices_enabled') },
    { key: 'alarms', label: 'Alarms', icon: Bell, to: '/alarms/', visible: hasPermission('module_measurements_enabled') },
    { key: 'alarm-report', label: 'Reports', icon: Calendar3, to: '/alarms/report/', visible: hasPermission('module_measurements_enabled') },
  ];

  const adminItems: Item[] = [
    { key: 'staff', label: 'Staff Admin', icon: People, to: '/staff/', visible: isStaffUser },
    { key: 'verwaltung', label: 'Object management', icon: Geo, to: '/verwaltung/', visible: isStaffUser },
    { key: 'anlegen', label: 'Create object', icon: Layers, to: '/anlegen/', visible: isStaffUser },
    { key: 'backup', label: 'Backup', icon: Database, to: '/backup/1/overview/', visible: hasPermission('module_backup_enabled') },
    { key: 'docker', label: 'Docker', icon: Box, to: '/docker/', visible: hasPermission('module_docker_enabled') },
    { key: 'admin-panel', label: 'Admin Panel', icon: Gear, to: '/admin/panel/', visible: hasPermission('module_admin_enabled') },
  ];
  const showAdminGroup = adminItems.some((item) => item.visible);

  // Unconditional today (Navbar.jsx never gated the Tools menu) - kept that way.
  const toolItems: Item[] = [
    { key: 'factory', label: 'Factory', icon: Map, to: '/factory/', visible: true },
    { key: 'lageplan', label: 'Lageplan Wizard', icon: Layers, to: '/lageplan/wizard/', visible: true },
    { key: 'map', label: 'Map', icon: Geo, to: '/map/', visible: true },
    { key: 'legacy', label: 'Legacy Import', icon: FileEarmarkText, to: '/legacy/import/', visible: true },
    { key: 'ws-debug', label: 'WS Debug', icon: Broadcast, to: '/ws-debug', visible: true },
    { key: 'dev', label: 'Dev', icon: Terminal, to: '/dev', visible: true },
  ];

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
    return routerLocation.pathname === to || routerLocation.pathname.startsWith(prefix);
  };

  const renderItem = (item: Item) => {
    if (!item.visible) {
      return null;
    }
    const Icon = item.icon;
    return (
      <Link key={item.key} to={item.to} style={itemStyle(isActive(item.to))}>
        <Icon size={17} style={{ flexShrink: 0 }} />
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.label}</span>
      </Link>
    );
  };

  const navContent = (
    <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {topItems.map(renderItem)}

      {showAdminGroup && (
        <>
          <div style={groupLabelStyle}>Admin</div>
          {adminItems.map(renderItem)}
        </>
      )}

      <div style={groupLabelStyle}>Tools</div>
      {toolItems.map(renderItem)}

    </nav>
  );

  return (
    <SidebarShell width={220} toggleLabel="Menu" closeLabel="Close menu">
      {navContent}
    </SidebarShell>
  );
};

export default AppSidebar;
