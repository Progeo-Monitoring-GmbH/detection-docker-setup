import { describe, expect, it } from 'vitest';
import {
  PORTAL_NAV_ITEMS,
  openLocationId,
  portalNavPath,
  portalTabOf,
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
  it('builds /location/<id>/<segment> for numeric and string ids', () => {
    const status = PORTAL_NAV_ITEMS[0];
    expect(portalNavPath(status, 42)).toBe('/location/42/status');
    expect(portalNavPath(status, '7')).toBe('/location/7/status');
  });

  it('uses the segment, not the key', () => {
    const benach = PORTAL_NAV_ITEMS.find((item) => item.key === 'benach');
    expect(benach).toBeDefined();
    expect(portalNavPath(benach!, 1)).toBe('/location/1/benachrichtigungen');
  });

  it('produces a distinct path for every item', () => {
    const paths = PORTAL_NAV_ITEMS.map((item) => portalNavPath(item, 3));
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('switchLocationPath', () => {
  it.each([
    ['/location/12/objekt', '/location/7/objekt'],
    ['/location/12/benachrichtigungen', '/location/7/benachrichtigungen'],
    ['/location/12/status/', '/location/7/status'],
    // A deeper path belongs to the open location - only its tab is kept.
    ['/location/12/einstellungen/lageplan/3', '/location/7/einstellungen'],
  ])('keeps the tab of %s', (pathname, expected) => {
    expect(switchLocationPath(pathname, 7)).toBe(expected);
  });

  it.each(['/location/12/heatmap2d', '/location/12/alarms/'])(
    'stays on the location page %s',
    (pathname) => {
      expect(switchLocationPath(pathname, 7)).toBe(pathname.replace('12', '7').replace(/\/$/, ''));
    },
  );

  it.each([
    ['/checklist/location/', '?location=12', '/checklist/location/?location=7'],
    ['/device/overview', '?location=12&ping=1', '/device/overview?location=7'],
    ['/lageplan/wizard/', '?location=12&plan=3', '/lageplan/wizard/?location=7'],
  ])('keeps the page of %s%s, only the location changes', (pathname, search, expected) => {
    expect(switchLocationPath(pathname, 7, search)).toBe(expected);
  });

  it.each(['/alarms/', '/location/overview/', '/location/12/unknown', '/', '/checklist/location/'])(
    'opens the status page from %s',
    (pathname) => {
      expect(switchLocationPath(pathname, 7)).toBe('/location/7/status');
    },
  );

  it('knows the location a page shows', () => {
    expect(openLocationId('/location/12/objekt')).toBe(12);
    expect(openLocationId('/checklist/location/', '?location=12')).toBe(12);
    expect(openLocationId('/checklist/location/', '')).toBeNull();
    expect(openLocationId('/location/overview/')).toBeNull();
  });

  it('knows the tab of a location page only', () => {
    expect(portalTabOf('/location/3/rechte')?.key).toBe('rechte');
    expect(portalTabOf('/device/overview')).toBeNull();
  });
});
