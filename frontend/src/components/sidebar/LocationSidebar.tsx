import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation as useRouterLocation } from 'react-router';
import {
  Bell,
  Calendar3,
  Database,
  ExclamationTriangle,
  Gear,
  Geo,
  GraphUp,
  Hdd,
  Layers,
  People,
  Plug,
  Terminal,
} from 'react-bootstrap-icons';
import { useAuth } from '../../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../../axiosConfig';
import { portalItemRule, routeRule, useAccess } from '../../main/access';
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
 * Visibility of every item is its route's rule in access.ts - the same rule
 * guards the page itself.
 */
const LocationSidebar = ({
  location = null,
  locationId = null,
}: LocationSidebarProps) => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { can, hasPermission } = useAccess();
  const role = useProgeoRole();
  const routerLocation = useRouterLocation();

  const [openClusterCount, setOpenClusterCount] = useState<number | null>(null);

  // Once per location: hasPermission is a new function on every render, and
  // `auth` changes with the path - neither is a reason to ask again.
  const canSeeMeasurements = hasPermission('module_measurements_enabled');
  const authRef = useRef(auth);
  authRef.current = auth;
  useEffect(() => {
    if (!locationId || !canSeeMeasurements) {
      setOpenClusterCount(null);
      return;
    }
    void axiosConfig.perform_get(
      authRef.current,
      `/v1/alarm/clusters/?location=${locationId}&days=90`,
      (response) => {
        const clusters = (response?.data?.clusters || []) as {
          state: string;
        }[];
        setOpenClusterCount(
          clusters.filter((cluster) => cluster.state !== 'geloest').length,
        );
      },
      () => setOpenClusterCount(null),
    );
  }, [canSeeMeasurements, locationId]);

  // The routes are guarded by the same rules (access.ts) - an item shows
  // exactly when its page opens.
  const visibleItems = PORTAL_NAV_ITEMS.filter((item) =>
    can(portalItemRule(item)),
  );
  // ProGeo-Admins (superusers) manage objects.
  const canCreateLocation =
    role === 'progeo-admin' && can(routeRule('/verwaltung/'));
  const verwaltungPath = canCreateLocation
    ? '/verwaltung/'
    : '/location/overview/';

  const [locationCount, setLocationCount] = useState<number | null>(null);

  useEffect(() => {
    if (!canCreateLocation || !hasPermission('module_locations_enabled')) {
      setLocationCount(null);
      return;
    }
    void axiosConfig.perform_get(
      auth,
      '/v1/location/min/',
      (response) =>
        setLocationCount(((response?.data || []) as unknown[]).length),
      () => setLocationCount(null),
    );
  }, [auth, canCreateLocation, hasPermission]);

  // Cross-object modules, listed under "Alle Objekte". The location list is
  // only extra for object managers - everyone else's "Verwaltung" link above
  // already leads there.
  const objectItems: ModuleItem[] = [
    {
      key: 'location',
      label: t('sidebar_locations'),
      icon: Geo,
      to: '/location/overview/',
      visible:
        canCreateLocation &&
        can(routeRule('/location/overview/')) &&
        (locationCount ?? 0) > 1,
    },
    {
      key: 'device',
      label: t('sidebar_devices'),
      icon: Hdd,
      to: '/device/overview',
      visible: can(routeRule('/device/overview')),
    },
    {
      // Staff tool: devices/locations in need of attention (type, chip ID,
      // 24 h activity, missing Lageplan, dead/unused).
      key: 'device-statistics',
      label: t('sidebar_device_statistics'),
      icon: GraphUp,
      to: '/device/statistics/',
      visible: can(routeRule('/device/statistics/')),
    },
    {
      key: 'alarms',
      label: t('sidebar_alarms'),
      icon: Bell,
      to: '/alarms/',
      visible: can(routeRule('/alarms/')),
    },
    {
      key: 'alarm-report',
      label: t('sidebar_reports'),
      icon: Calendar3,
      to: '/alarms/report/',
      visible: can(routeRule('/alarms/report/')),
    },
    {
      // Every staff user sees the escalations; only superusers open them.
      key: 'escalations',
      label: t('sidebar_escalations'),
      icon: ExclamationTriangle,
      to: '/escalations/',
      visible: can(routeRule('/escalations/')),
    },
  ];

  const adminItems: ModuleItem[] = [
    {
      key: 'staff',
      label: t('sidebar_staff_admin'),
      icon: People,
      to: '/staff/',
      visible: can(routeRule('/staff/')),
    },
    {
      // SMTP/Modbus/SMS/messenger - system-wide, not per location.
      key: 'schnittstelle',
      label: t('nav_schnittstelle'),
      icon: Plug,
      to: '/schnittstelle/',
      visible: can(routeRule('/schnittstelle/')),
    },
    {
      key: 'backup',
      label: t('sidebar_backup'),
      icon: Database,
      to: '/backup/1/overview/',
      visible: can(routeRule('/backup/:account/overview/')),
    },
    {
      key: 'admin-panel',
      label: t('sidebar_admin_panel'),
      icon: Gear,
      to: '/admin/panel/',
      visible: can(routeRule('/admin/panel/')),
    },
  ];

  const toolItems: ModuleItem[] = [
    {
      key: 'lageplan',
      label: t('sidebar_lageplan_wizard'),
      icon: Layers,
      to: '/lageplan/wizard/',
      visible: can(routeRule('/lageplan/wizard/')),
    },
    {
      key: 'map',
      label: t('sidebar_map'),
      icon: Geo,
      to: '/map/',
      visible: can(routeRule('/map/')),
    },
    {
      // Docker, Legacy Import, WS Debug and Dev - tabs of DeveloperView.
      key: 'developer',
      label: t('sidebar_developer'),
      icon: Terminal,
      to: '/developer/',
      visible: can(routeRule('/developer')),
    },
  ];

  const isActivePrefix = (to: string) => {
    const prefix = to.endsWith('/') ? to : `${to}/`;
    return (
      routerLocation.pathname === to ||
      routerLocation.pathname.startsWith(prefix)
    );
  };

  const itemStyle = (active: boolean, global: boolean, collapsed: boolean): CSSProperties => ({
    ...sidebarItemBaseStyle,
    justifyContent: collapsed ? 'center' : 'space-between',
    gap: 8,
    ...(collapsed ? { padding: '11px 0', position: 'relative' } : {}),
    color: global ? '#4F6B85' : 'var(--progeo-blue)',
    background: active
      ? global
        ? '#E2DFDE'
        : 'var(--progeo-surface)'
      : 'transparent',
    boxShadow: active
      ? global
        ? 'inset 0 0 0 1px #D0CACA'
        : SIDEBAR_ACTIVE_SHADOW
      : 'none',
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

  /**
   * A nav link: icon and label - folded only the icon, the label as its
   * tooltip and accessible name; a badge becomes a dot on the icon.
   */
  const renderLink = ({
    key,
    to,
    active,
    global,
    icon,
    label,
    badge,
    collapsed,
  }: {
    key: string;
    to: string;
    active: boolean;
    global: boolean;
    icon: ReactNode;
    label: string;
    badge?: number | null;
    collapsed: boolean;
  }) => (
    <Link
      key={key}
      to={to}
      style={itemStyle(active, global, collapsed)}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          minWidth: 0,
        }}
      >
        {icon}
        {!collapsed && (
          <span
            style={{
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {label}
          </span>
        )}
      </span>
      {badge != null && badge > 0 && (
        collapsed ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 6,
              right: 10,
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--progeo-orange)',
            }}
          />
        ) : (
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
        )
      )}
    </Link>
  );

  const renderModuleItem = (item: ModuleItem, collapsed: boolean) => {
    if (!item.visible) {
      return null;
    }
    const Icon = item.icon;
    return renderLink({
      key: item.key,
      to: item.to,
      active: isActivePrefix(item.to),
      global: true,
      icon: <Icon size={17} style={{ flexShrink: 0 }} />,
      label: item.label,
      collapsed,
    });
  };

  /** A group caption - folded a plain divider. */
  const renderGroupLabel = (label: string, separated: boolean, collapsed: boolean) =>
    collapsed ? (
      separated && <div aria-hidden="true" style={{ margin: '8px 6px', borderTop: '1px solid #D9D4D4' }} />
    ) : (
      <div style={sidebarGroupLabelStyle(separated)}>{label}</div>
    );

  const renderModuleGroup = (label: string, items: ModuleItem[], collapsed: boolean) =>
    items.some((item) => item.visible) && (
      <>
        {renderGroupLabel(label, true, collapsed)}
        {items.map((item) => renderModuleItem(item, collapsed))}
      </>
    );

  const renderNav = (collapsed: boolean) => (
    <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {location && (
        <>
          {renderGroupLabel(location.name ?? '', false, collapsed)}
          {visibleItems.map((item) => {
            const path = portalNavPath(item, locationId as number);
            return renderLink({
              key: item.key,
              to: path,
              active: routerLocation.pathname === path,
              global: false,
              icon: renderIcon(item.icon),
              label: t(item.labelKey),
              badge: item.key === 'status' ? openClusterCount : null,
              collapsed,
            });
          })}
        </>
      )}

      {renderGroupLabel(t('nav_alle_objekte'), true, collapsed)}
      {renderLink({
        key: 'verwaltung',
        to: verwaltungPath,
        active: routerLocation.pathname === verwaltungPath,
        global: true,
        icon: renderIcon('M4 6h16M4 12h16M4 18h16'),
        label: t('nav_verwaltung'),
        collapsed,
      })}
      {canCreateLocation &&
        renderLink({
          key: 'anlegen',
          to: '/anlegen/',
          active: routerLocation.pathname === '/anlegen/',
          global: true,
          icon: renderIcon('M12 5v14M5 12h14'),
          label: t('nav_anlegen'),
          collapsed,
        })}
      {objectItems.map((item) => renderModuleItem(item, collapsed))}

      {renderModuleGroup(t('sidebar_group_admin'), adminItems, collapsed)}
      {renderModuleGroup(t('sidebar_group_tools'), toolItems, collapsed)}
    </nav>
  );

  return (
    <SidebarShell
      width={248}
      subtitle={t('nav_portal_title')}
      toggleLabel={t('nav_menu_toggle')}
      closeLabel={t('nav_menu_close')}
      collapseLabel={t('nav_sidebar_collapse')}
      expandLabel={t('nav_sidebar_expand')}
    >
      {({ collapsed }) => renderNav(collapsed)}
    </SidebarShell>
  );
};

export default LocationSidebar;
