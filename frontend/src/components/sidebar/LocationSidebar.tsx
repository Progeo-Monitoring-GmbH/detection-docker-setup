import { type CSSProperties, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation as useRouterLocation } from 'react-router';
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
  location: LocationDetail | null;
  locationId: number | null;
};

/**
 * Sidebar chrome for the object/location monitoring portal, ported from the
 * "Portal v2" mockup's <aside> (ProGeo Portal v2.dc.html, ~line 40-66 for
 * markup, ~line 1499 for the navDefs data this is built from). Only mounted
 * inside LocationPortalLayout - every other module keeps the top Navbar.
 */
const LocationSidebar = ({ location, locationId }: LocationSidebarProps) => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { hasPermission } = usePermissions();
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
  const canCreateLocation = role === 'progeo-admin';

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
        to={canCreateLocation ? '/verwaltung/' : '/location/overview/'}
        style={itemStyle(
          routerLocation.pathname === '/location/overview/' ||
            routerLocation.pathname === '/verwaltung/',
          true,
        )}
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
