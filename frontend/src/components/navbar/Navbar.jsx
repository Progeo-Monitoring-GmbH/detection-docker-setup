import React from 'react';
import {
  Activity,
  Bell,
  Box,
  Broadcast,
  Database,
  DoorOpen,
  Gear,
  Geo,
  Hdd,
  House,
  Layers,
  Map,
  Phone,
  Terminal,
  Wrench,
} from 'react-bootstrap-icons';
import {
  Breadcrumb,
  Button,
  Col,
  Container,
  Nav,
  Navbar as BsNavbar,
  NavDropdown,
} from 'react-bootstrap';
import { useLocation } from 'react-router';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import usePermissions from '../../../hooks/usePermissions';
import './Navbar.css';

/** Map pathname prefixes to the sidebar section they belong to. */
const sectionFromPath = (pathname) => {
  if (pathname.startsWith('/device/measure')) return 'measure';
  if (pathname.startsWith('/device/')) return 'device';
  if (pathname.startsWith('/devices/imei')) return 'imei';
  if (pathname.startsWith('/devices/')) return 'device';
  if (pathname.startsWith('/location/') || pathname.startsWith('/locations/')) {
    return 'location';
  }
  if (pathname.startsWith('/alarms')) return 'alarms';
  if (pathname.startsWith('/backup')) return 'backup';
  if (pathname.startsWith('/docker')) return 'docker';
  if (pathname.startsWith('/admin')) return 'adminpanel';
  if (pathname.startsWith('/factory')) return 'tools';
  if (pathname.startsWith('/lageplan')) return 'tools';
  if (pathname.startsWith('/map')) return 'tools';
  if (pathname.startsWith('/ws-debug')) return 'tools';
  if (pathname.startsWith('/dev')) return 'tools';
  return null;
};

/** Humanized label for the last path segment (e.g. "heatmap2d" -> "Heatmap 2d"). */
const segmentLabel = (segment) => {
  if (!segment) {
    return '';
  }
  const readable = segment
    .replace(/[-_]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return readable.charAt(0).toUpperCase() + readable.slice(1);
};

/** Build breadcrumb trail from the current pathname. */
const buildBreadcrumbs = (pathname) => {
  const crumbs = [{ label: 'Home', to: '/' }];
  const parts = pathname.split('/').filter(Boolean);

  // Skip a leading numeric account id segment (e.g. /v1/0/...).
  const segments = parts[0] && /^\d+$/.test(parts[0]) ? parts.slice(1) : parts;

  const sectionToLabel = {
    device: 'Devices',
    location: 'Locations',
    alarms: 'Alarms',
    measure: 'Measurements',
    imei: 'IMEI Display',
    backup: 'Backup',
    docker: 'Docker',
    adminpanel: 'Admin Panel',
    tools: 'Tools',
  };

  const section = sectionFromPath(pathname);
  if (section && sectionToLabel[section]) {
    const sectionTarget = {
      device: '/device/overview/',
      location: '/location/overview/',
      alarms: '/alarms/',
      measure: '/device/measure',
      imei: '/devices/imei/display/',
      backup: '/backup/1/overview/',
      docker: '/docker/',
      adminpanel: '/admin/panel/',
      tools: null,
    }[section];
    crumbs.push({ label: sectionToLabel[section], to: sectionTarget });

    // Append remaining path segments as detail crumbs (non-clickable).
    const knownSections = new Set([
      'device',
      'location',
      'locations',
      'alarms',
      'measure',
      'devices',
      'backup',
      'docker',
      'admin',
      'factory',
      'lageplan',
      'map',
      'ws-debug',
      'dev',
      'overview',
      'display',
      'update',
      'detail',
    ]);
    for (const segment of segments) {
      if (knownSections.has(segment)) {
        continue;
      }
      const label = /^\d+$/.test(segment)
        ? `#${segment}`
        : segmentLabel(segment);
      crumbs.push({ label, to: null });
    }
  }

  return crumbs;
};

const Navbar = ({ act, content }) => {
  const auth = useAuth();
  const { hasPermission } = usePermissions();
  const location = useLocation();

  const pathname = location.pathname || '/';
  const activeSection = sectionFromPath(pathname) || act || null;

  const crumbs = React.useMemo(() => buildBreadcrumbs(pathname), [pathname]);

  const logout = () => {
    auth.logoutAction();
  };

  const navLink = (section, label, icon, target) => {
    const Icon = icon;
    return (
      <Nav.Link
        key={section}
        href={target}
        active={activeSection === section}
        className="px-3"
      >
        <Icon size={16} />
        <span>{label}</span>
      </Nav.Link>
    );
  };

  return (
    <>
      <Col md={12} id={'v1-Navbar'}>
        <BsNavbar
          collapseOnSelect
          expand="lg"
          variant="dark"
          bg="dark"
          className="progeo-topnav px-3 py-1"
        >
          <Container fluid>
            <BsNavbar.Brand href="/">
              <House size={20} />
              <span>PROGEO</span>
            </BsNavbar.Brand>
            <BsNavbar.Toggle aria-controls="progeo-navbar-nav" />
            <BsNavbar.Collapse id="progeo-navbar-nav">
              <Nav className="me-auto align-items-lg-center">
                {hasPermission('module_devices_enabled') &&
                  navLink('device', 'Devices', Hdd, '/device/overview/')}
                {hasPermission('module_locations_enabled') &&
                  navLink('location', 'Locations', Geo, '/location/overview/')}
                {hasPermission('module_measurements_enabled') &&
                  navLink('measure', 'Measurements', Activity, '/device/measure')}
                {hasPermission('module_measurements_enabled') &&
                  navLink('alarms', 'Alarms', Bell, '/alarms/')}
                {hasPermission('module_imei_enabled') &&
                  navLink('imei', 'IMEI Display', Phone, '/devices/imei/display/')}
                {hasPermission('module_backup_enabled') &&
                  navLink('backup', 'Backup', Database, '/backup/1/overview/')}
                {hasPermission('module_docker_enabled') &&
                  navLink('docker', 'Docker', Box, '/docker/')}
                {hasPermission('module_admin_enabled') &&
                  navLink('adminpanel', 'Admin Panel', Gear, '/admin/panel/')}
                <NavDropdown
                  title={
                    <span className="d-inline-flex align-items-center gap-2">
                      <Wrench size={16} />
                      Tools
                    </span>
                  }
                  id="progeo-tools-dropdown"
                  active={activeSection === 'tools'}
                >
                  <NavDropdown.Item href="/factory/">
                    <Map size={16} className="me-2" />
                    Factory
                  </NavDropdown.Item>
                  <NavDropdown.Item href="/lageplan/wizard/">
                    <Layers size={16} className="me-2" />
                    Lageplan Wizard
                  </NavDropdown.Item>
                  <NavDropdown.Item href="/map/">
                    <Geo size={16} className="me-2" />
                    Map
                  </NavDropdown.Item>
                  <NavDropdown.Divider />
                  <NavDropdown.Item href="/ws-debug">
                    <Broadcast size={16} className="me-2" />
                    WS Debug
                  </NavDropdown.Item>
                  <NavDropdown.Item href="/dev">
                    <Terminal size={16} className="me-2" />
                    Dev
                  </NavDropdown.Item>
                </NavDropdown>
              </Nav>
              <Nav>
                <Button
                  variant="outline-light"
                  size="sm"
                  className="progeo-navbar-logout"
                  onClick={logout}
                >
                  <DoorOpen size={16} className="me-1" />
                  Logout
                </Button>
              </Nav>
            </BsNavbar.Collapse>
          </Container>
        </BsNavbar>

        <div className="progeo-breadcrumbs">
          <Breadcrumb>
            {crumbs.map((crumb, index) =>
              crumb.to && index < crumbs.length - 1 ? (
                <Breadcrumb.Item key={index} href={crumb.to}>
                  {crumb.label}
                </Breadcrumb.Item>
              ) : (
                <Breadcrumb.Item key={index} active>
                  {crumb.label}
                </Breadcrumb.Item>
              ),
            )}
          </Breadcrumb>
        </div>
      </Col>
      <Col md={12} className={`ps-3 pt-3`}>
        {content}
      </Col>
    </>
  );
};

export default Navbar;
