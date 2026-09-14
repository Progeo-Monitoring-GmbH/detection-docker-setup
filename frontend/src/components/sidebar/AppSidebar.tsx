import { type CSSProperties, useEffect, useState } from 'react';
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
  House,
  Layers,
  List,
  Map,
  People,
  Terminal,
  X,
} from 'react-bootstrap-icons';
import { useAuth } from '../../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../../hooks/usePermissions';

const MOBILE_BREAKPOINT = 860;

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

  const [mobile, setMobile] = useState(
    typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT,
  );
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [routerLocation.pathname]);

  const isStaffUser = Boolean((auth?.user as { is_staff?: boolean } | null)?.is_staff);

  const topItems: Item[] = [
    { key: 'location', label: 'Locations', icon: Geo, to: '/location/overview/', visible: hasPermission('module_locations_enabled') },
    { key: 'device', label: 'Devices', icon: Hdd, to: '/device/overview', visible: hasPermission('module_devices_enabled') },
    { key: 'alarms', label: 'Alarms', icon: Bell, to: '/alarms/', visible: hasPermission('module_measurements_enabled') },
    { key: 'alarm-report', label: 'Reports', icon: Calendar3, to: '/alarms/report/', visible: hasPermission('module_measurements_enabled') },
  ];

  const adminItems: Item[] = [
    { key: 'staff', label: 'Staff Admin', icon: People, to: '/staff/', visible: isStaffUser },
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

  const groupLabelStyle: CSSProperties = {
    fontSize: 10,
    letterSpacing: '.12em',
    textTransform: 'uppercase',
    color: '#A09898',
    fontWeight: 600,
    padding: '16px 14px 7px',
    marginTop: 8,
    borderTop: '1px solid #D9D4D4',
  };

  const itemStyle = (active: boolean): CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 11,
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
    color: 'var(--progeo-blue)',
    background: active ? 'var(--progeo-surface)' : 'transparent',
    boxShadow: active ? '0 3px 12px rgba(11, 54, 89, .1)' : 'none',
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
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Menu"
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
            }}
          >
            {menuOpen ? <X size={20} /> : <List size={20} />}
          </button>
        </div>
        {menuOpen && (
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(11, 54, 89, .28)', zIndex: 55, border: 'none', padding: 0 }}
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
    <aside style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', padding: '20px 14px 18px 18px', gap: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <House size={18} />
        <div style={{ fontSize: 13, fontWeight: 600 }}>ProGeo</div>
      </div>
      {navContent}
    </aside>
  );
};

export default AppSidebar;
