import { type CSSProperties, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import axiosConfig from '../../axiosConfig';
import { useProgeoRole } from '../../main/roleModel';
import { PORTAL_NAV_ITEMS, portalNavPath } from '../../main/portalNav';
import type { LocationDetail } from '../../main/locationTypes';
import SidebarShell, {
  SIDEBAR_ACTIVE_SHADOW,
  sidebarGroupLabelStyle,
  sidebarItemBaseStyle,
} from './SidebarShell';

type LocationSidebarProps = {
  /** The open location (portal routes) - null everywhere else. */
  location?: LocationDetail | null;
  locationId?: number | null;
};

type ModuleItem = {
  key: string;
  label: string;
  icon: typeof Geo;
  to: string;
  visible: boolean;
};

/**
 * The app's sidebar, ported from the "Portal v2" mockup's <aside> (ProGeo
 * Portal v2.dc.html, ~line 40-66 for markup, ~line 1499 for the navDefs data
 * this is built from). Mounted by LocationPortalLayout (with the open
 * location's tabs on top) and by AppLayout for every other route (without).
 *
 * Visibility of the module items: staff see Staff Admin; everything else is
 * superuser-only, Backup additionally needs its module permission.
 * is_staff and is_superuser are separate roles - superusers see every item,
 * staff only the ones explicitly listed for them.
 */
const LocationSidebar = ({
  location = null,
  locationId = null,
}: LocationSidebarProps) => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { hasPermission, isAdmin: isSuperuser } = usePermissions();
  const role = useProgeoRole();
  const routerLocation = useRouterLocation();

  const [openClusterCount, setOpenClusterCount] = useState<number | null>(null);

  useEffect(() => {
    if (!locationId || !hasPermission('module_measurements_enabled')) {
      setOpenClusterCount(null);
      return;
    }
    void axiosConfig.perform_get(
      auth,
      `/v1/alarm/clusters/?location=${locationId}&days=90`,
      (response) => {
        const clusters = (response?.data?.clusters || []) as { state: string }[];
        setOpenClusterCount(clusters.filter((cluster) => cluster.state !== 'geloest').length);
      },
      () => setOpenClusterCount(null),
    );
  }, [auth, hasPermission, locationId]);

  const visibleItems = PORTAL_NAV_ITEMS.filter((item) => hasPermission(item.permission));
  // Staff (progeo-admin) and superusers manage objects.
  const canCreateLocation = role === 'progeo-admin' || isSuperuser;
  const isStaffUser = role === 'progeo-admin';
  const verwaltungPath = canCreateLocation ? '/verwaltung/' : '/location/overview/';

  // Cross-object modules, listed under "Alle Objekte". The location list is
  // only extra for object managers - everyone else's "Verwaltung" link above
  // already leads there.
  const objectItems: ModuleItem[] = [
    {
      key: 'location',
      label: t('sidebar_locations'),
      icon: Geo,
      to: '/location/overview/',
      visible: canCreateLocation && hasPermission('module_locations_enabled'),
    },
    { key: 'device', label: t('sidebar_devices'), icon: Hdd, to: '/device/overview', visible: isSuperuser },
    { key: 'alarms', label: t('sidebar_alarms'), icon: Bell, to: '/alarms/', visible: isSuperuser },
    {
      key: 'alarm-report',
      label: t('sidebar_reports'),
      icon: Calendar3,
      to: '/alarms/report/',
      visible: isSuperuser,
    },
  ];

  const adminItems: ModuleItem[] = [
    {
      key: 'staff',
      label: t('sidebar_staff_admin'),
      icon: People,
      to: '/staff/',
      visible: isStaffUser || isSuperuser,
    },
    {
      key: 'backup',
      label: t('sidebar_backup'),
      icon: Database,
      to: '/backup/1/overview/',
      visible: hasPermission('module_backup_enabled'),
    },
    { key: 'docker', label: t('sidebar_docker'), icon: Box, to: '/docker/', visible: isSuperuser },
    {
      key: 'admin-panel',
      label: t('sidebar_admin_panel'),
      icon: Gear,
      to: '/admin/panel/',
      visible: isSuperuser,
    },
  ];

  const toolItems: ModuleItem[] = [
    { key: 'factory', label: t('sidebar_factory'), icon: Map, to: '/factory/', visible: isSuperuser },
    {
      key: 'lageplan',
      label: t('sidebar_lageplan_wizard'),
      icon: Layers,
      to: '/lageplan/wizard/',
      visible: isSuperuser,
    },
    { key: 'map', label: t('sidebar_map'), icon: Geo, to: '/map/', visible: isSuperuser },
    {
      key: 'legacy',
      label: t('sidebar_legacy_import'),
      icon: FileEarmarkText,
      to: '/legacy/import/',
      visible: isSuperuser,
    },
    { key: 'ws-debug', label: t('sidebar_ws_debug'), icon: Broadcast, to: '/ws-debug', visible: isSuperuser },
    { key: 'dev', label: t('sidebar_dev'), icon: Terminal, to: '/dev', visible: isSuperuser },
  ];

  const isActivePrefix = (to: string) => {
    const prefix = to.endsWith('/') ? to : `${to}/`;
    return routerLocation.pathname === to || routerLocation.pathname.startsWith(prefix);
  };

  const itemStyle = (active: boolean, global: boolean): CSSProperties => ({
    ...sidebarItemBaseStyle,
    justifyContent: 'space-between',
    gap: 8,
    color: global ? '#4F6B85' : 'var(--progeo-blue)',
    background: active ? (global ? '#E2DFDE' : 'var(--progeo-surface)') : 'transparent',
    boxShadow: active ? (global ? 'inset 0 0 0 1px #D0CACA' : SIDEBAR_ACTIVE_SHADOW) : 'none',
  });

  const renderIcon = (d: string) => (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d={d} />
    </svg>
  );

  const renderModuleItem = (item: ModuleItem) => {
    if (!item.visible) {
      return null;
    }
    const Icon = item.icon;
    return (
      <Link key={item.key} to={item.to} style={itemStyle(isActivePrefix(item.to), true)}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
          <Icon size={17} style={{ flexShrink: 0 }} />
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {item.label}
          </span>
        </span>
      </Link>
    );
  };

  const renderModuleGroup = (label: string, items: ModuleItem[]) =>
    items.some((item) => item.visible) && (
      <>
        <div style={sidebarGroupLabelStyle(true)}>{label}</div>
        {items.map(renderModuleItem)}
      </>
    );

  const navContent = (
    <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {location && (
        <>
          <div style={sidebarGroupLabelStyle(false)}>{location.name}</div>
          {visibleItems.map((item) => {
            const path = portalNavPath(item, locationId as number);
            const active = routerLocation.pathname === path;
            const badge = item.key === 'status' ? openClusterCount : null;
            return (
              <Link key={item.key} to={path} style={itemStyle(active, false)}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
                  {renderIcon(item.icon)}
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {t(item.labelKey)}
                  </span>
                </span>
                {badge != null && badge > 0 && (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: '#fff',
                      background: 'var(--progeo-orange)',
                      borderRadius: 'var(--progeo-radius-pill)',
                      padding: '2px 7px',
                    }}
                  >
                    {badge}
                  </span>
                )}
              </Link>
            );
          })}
        </>
      )}

      <div style={sidebarGroupLabelStyle(true)}>{t('nav_alle_objekte')}</div>
      <Link
        to={verwaltungPath}
        style={itemStyle(routerLocation.pathname === verwaltungPath, true)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
          {renderIcon('M4 6h16M4 12h16M4 18h16')}
          <span>{t('nav_verwaltung')}</span>
        </span>
      </Link>
      {canCreateLocation && (
        <Link to="/anlegen/" style={itemStyle(routerLocation.pathname === '/anlegen/', true)}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
            {renderIcon('M12 5v14M5 12h14')}
            <span>{t('nav_anlegen')}</span>
          </span>
        </Link>
      )}
      {objectItems.map(renderModuleItem)}

      {renderModuleGroup(t('sidebar_group_admin'), adminItems)}
      {renderModuleGroup(t('sidebar_group_tools'), toolItems)}
    </nav>
  );

  return (
    <SidebarShell
      width={248}
      subtitle={t('nav_portal_title')}
      toggleLabel={t('nav_menu_toggle')}
      closeLabel={t('nav_menu_close')}
    >
      {navContent}
    </SidebarShell>
  );
};

export default LocationSidebar;
