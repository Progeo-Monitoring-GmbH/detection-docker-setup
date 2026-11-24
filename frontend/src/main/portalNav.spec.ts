import { describe, expect, it } from 'vitest';
import {
  PORTAL_NAV_ITEMS,
  isOpenLocation,
  locationPagePath,
  openLocationId,
  openProjectId,
  portalNavPath,
  portalTabOf,
  projectPath,
  switchLocationPath,
} from './portalNav';

describe('PORTAL_NAV_ITEMS', () => {
  it('is non-empty and starts with the status page', () => {
    expect(PORTAL_NAV_ITEMS.length).toBeGreaterThan(0);
    expect(PORTAL_NAV_ITEMS[0].key).toBe('status');
  });

  it('has unique keys', () => {
    const keys = PORTAL_NAV_ITEMS.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has unique, URL-safe segments', () => {
    const segments = PORTAL_NAV_ITEMS.map((item) => item.segment);
    expect(new Set(segments).size).toBe(segments.length);
    segments.forEach((segment) => expect(segment).toMatch(/^[a-z0-9-]+$/));
  });

  it('has unique label keys', () => {
    const labels = PORTAL_NAV_ITEMS.map((item) => item.labelKey);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it.each(PORTAL_NAV_ITEMS.map((item) => [item.key, item] as const))(
    '%s has a module permission, a label key and an SVG path icon',
    (_key, item) => {
      expect(item.permission).toMatch(/^module_[a-z_]+$/);
      expect(item.labelKey).toMatch(/^nav_/);
      expect(item.icon.trim()).toMatch(/^M/);
      expect(item.icon).toMatch(/^[MLHVCSQTAZmlhvcsqtaz0-9 .,-]+$/);
    },
  );
});

describe('portalNavPath', () => {
  it('builds /project/<project_id>/<segment> for numeric and string numbers', () => {
    const status = PORTAL_NAV_ITEMS[0];
    expect(portalNavPath(status, 4711)).toBe('/project/4711/status');
    expect(portalNavPath(status, '7')).toBe('/project/7/status');
  });

  it('uses the segment, not the key', () => {
    const benach = PORTAL_NAV_ITEMS.find((item) => item.key === 'benach');
    expect(benach).toBeDefined();
    expect(portalNavPath(benach!, 1)).toBe('/project/1/notifications');
  });

  it('produces a distinct path for every item', () => {
    const paths = PORTAL_NAV_ITEMS.map((item) => portalNavPath(item, 3));
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('locationPagePath', () => {
  it('opens a location by its project number, with a query', () => {
    expect(projectPath(4711)).toBe('/project/4711/status');
    expect(projectPath(4711, 'analysis', '?plan=3')).toBe('/project/4711/analysis?plan=3');
    expect(locationPagePath({ id: 12, project_id: 4711 }, 'object')).toBe('/project/4711/object');
  });

  it('keeps the pk URL without a number or when the number opens another location', () => {
    expect(locationPagePath({ id: 12, project_id: null }, 'status', 'at=x')).toBe('/location/12/status?at=x');
    expect(locationPagePath({ id: 12, project_id: 4711, project_main: false })).toBe('/location/12/status');
    expect(locationPagePath({ id: 12, project_id: 4711, project_main: true })).toBe('/project/4711/status');
  });
});

describe('switchLocationPath', () => {
  const other = { id: 7, project_id: 4700 };

  it.each([
    ['/project/4711/object', '/project/4700/object'],
    ['/project/4711/notifications', '/project/4700/notifications'],
    ['/project/4711/status/', '/project/4700/status'],
    // A deeper path belongs to the open location - only its tab is kept.
    ['/project/4711/settings/lageplan/3', '/project/4700/settings'],
    ['/location/12/object', '/project/4700/object'],
    ['/project/4711/alarms/', '/project/4700/alarms'],
  ])('keeps the tab of %s', (pathname, expected) => {
    expect(switchLocationPath(pathname, other)).toBe(expected);
  });

  it.each([
    ['/checklist/location/', '?location=12', '/checklist/location/?location=7'],
    ['/device/overview', '?location=12&ping=1', '/device/overview?location=7'],
    ['/site-plan/wizard/', '?location=12&plan=3', '/site-plan/wizard/?location=7'],
  ])('keeps the page of %s%s, only the location (pk) changes', (pathname, search, expected) => {
    expect(switchLocationPath(pathname, other, search)).toBe(expected);
  });

  it.each(['/alarms/', '/location/overview/', '/project/4711/unknown', '/', '/checklist/location/'])(
    'opens the status page from %s',
    (pathname) => {
      expect(switchLocationPath(pathname, other)).toBe('/project/4700/status');
    },
  );

  it('knows the location a page shows', () => {
    expect(openProjectId('/project/4711/object')).toBe(4711);
    expect(openProjectId('/location/overview/')).toBeNull();
    expect(openLocationId('/checklist/location/', '?location=12')).toBe(12);
    expect(openLocationId('/location/12/status')).toBe(12);
    expect(openLocationId('/checklist/location/', '')).toBeNull();
    expect(isOpenLocation({ id: 12, project_id: 4711 }, '/project/4711/status')).toBe(true);
    expect(isOpenLocation({ id: 4711, project_id: 1 }, '/project/4711/status')).toBe(false);
    expect(isOpenLocation({ id: 12, project_id: 4711 }, '/checklist/location/', '?location=12')).toBe(true);
    expect(isOpenLocation({ id: 12, project_id: 4711 }, '/location/12/object')).toBe(true);
    expect(isOpenLocation({ id: 13, project_id: 4711 }, '/location/12/object')).toBe(false);
  });

  it('knows the tab of a location page only', () => {
    expect(portalTabOf('/project/3/permissions')?.key).toBe('rechte');
    expect(portalTabOf('/location/3/permissions')?.key).toBe('rechte');
    expect(portalTabOf('/device/overview')).toBeNull();
  });
});
