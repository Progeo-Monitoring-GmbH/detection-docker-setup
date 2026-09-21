import { type CSSProperties, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation as useRouterLocation } from 'react-router';
import { House, List, X } from 'react-bootstrap-icons';
import { useAuth } from '../../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../../hooks/usePermissions';
import axiosConfig from '../../axiosConfig';
import { useProgeoRole } from '../../main/roleModel';
import { PORTAL_NAV_ITEMS, portalNavPath } from '../../main/portalNav';
import type { LocationDetail } from '../../main/locationTypes';

type LocationSidebarProps = {
  location: LocationDetail | null;
  locationId: number | null;
};

const MOBILE_BREAKPOINT = 860;

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

  const [mobile, setMobile] = useState(
    typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [openClusterCount, setOpenClusterCount] = useState<number | null>(null);

  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [routerLocation.pathname]);

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

  const groupLabelStyle: CSSProperties = {
    fontSize: 10,
    letterSpacing: '.12em',
    textTransform: 'uppercase',
    color: '#A09898',
    fontWeight: 600,
    padding: '2px 14px 7px',
  };

  const itemStyle = (active: boolean, global: boolean): CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    width: '100%',
    textAlign: 'left',
    whiteSpace: 'nowrap',
    padding: '11px 14px',
    border: 'none',
    borderRadius: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 14,
    fontWeight: 500,
    color: global ? '#4F6B85' : 'var(--progeo-blue)',
    background: active
      ? global
        ? '#E2DFDE'
        : 'var(--progeo-surface)'
      : 'transparent',
    boxShadow: active ? (global ? 'inset 0 0 0 1px #D0CACA' : '0 3px 12px rgba(11, 54, 89, .1)') : 'none',
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
          <div style={groupLabelStyle}>{location.name}</div>
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

      <div
        style={{
          ...groupLabelStyle,
          padding: '16px 14px 7px',
          marginTop: 8,
          borderTop: '1px solid #D9D4D4',
        }}
      >
        {t('nav_alle_objekte')}
      </div>
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

  if (mobile) {
    return (
      <aside
        style={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: '11px 12px',
          position: 'sticky',
          top: 0,
          zIndex: 60,
          background: 'var(--progeo-page-bg)',
          boxShadow: '0 8px 18px -14px rgba(11, 54, 89, .3)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <House size={18} />
          <div style={{ fontSize: 13, fontWeight: 600 }}>ProGeo</div>
          <div style={{ width: 1, height: 22, background: '#D0CACA', flexShrink: 0 }} />
          <div
            style={{
              fontSize: 10,
              letterSpacing: '.12em',
              textTransform: 'uppercase',
              color: '#6E6868',
              fontWeight: 500,
              whiteSpace: 'nowrap',
            }}
          >
            {t('nav_portal_title')}
          </div>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={t('nav_menu_toggle')}
            style={{
              marginLeft: 'auto',
              width: 40,
              height: 40,
              flexShrink: 0,
              border: 'none',
              borderRadius: 12,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--progeo-blue)',
              background: menuOpen ? 'var(--progeo-surface)' : 'transparent',
              boxShadow: menuOpen ? '0 2px 10px rgba(11, 54, 89, .12)' : 'none',
            }}
          >
            {menuOpen ? <X size={20} /> : <List size={20} />}
          </button>
        </div>

        {menuOpen && (
          <button
            type="button"
            aria-label={t('nav_menu_close')}
            onClick={() => setMenuOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(11, 54, 89, .28)',
              zIndex: 55,
              border: 'none',
              padding: 0,
            }}
          />
        )}

        {menuOpen && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              background: 'var(--progeo-surface)',
              padding: '8px 10px 14px',
              borderRadius: '0 0 18px 18px',
              boxShadow: '0 22px 44px rgba(11, 54, 89, .22)',
              maxHeight: 'calc(100vh - 70px)',
              overflow: 'auto',
              zIndex: 62,
            }}
          >
            {navContent}
          </div>
        )}
      </aside>
    );
  }

  return (
    <aside
      style={{
        width: 248,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        padding: '20px 14px 18px 18px',
        gap: 22,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <House size={18} />
        <div style={{ fontSize: 13, fontWeight: 600 }}>ProGeo</div>
        <div style={{ width: 1, height: 22, background: '#D0CACA', flexShrink: 0 }} />
        <div
          style={{
            fontSize: 10,
            letterSpacing: '.12em',
            textTransform: 'uppercase',
            color: '#6E6868',
            fontWeight: 500,
            lineHeight: 1.3,
          }}
        >
          {t('nav_portal_title')}
        </div>
      </div>
      {navContent}
    </aside>
  );
};

export default LocationSidebar;
