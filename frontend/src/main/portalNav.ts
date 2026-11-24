export type PortalNavItem = {
  key: 'status' | 'objekt' | 'analyse' | 'benach' | 'rechte' | 'einstell';
  labelKey: string;
  /** SVG path `d` attribute, viewBox 0 0 24 24 - matches the mockup's icon style. */
  icon: string;
  /** Real module permission code - gates both nav visibility and route access. */
  permission: string;
  segment: string;
};

/**
 * Per-object sidebar items, ported from the "Portal v2" mockup's `navDefs`
 * (ProGeo Portal v2.dc.html, ~line 1499). Access control uses the app's real
 * permission codes (usePermissions().hasPermission), not the mockup's
 * coarser 0/1/2 role-level scheme - that scheme only informed which items
 * belong here and their order.
 *
 * The interface configuration (SMTP/Modbus/SMS/messenger) is system-wide,
 * not per object - it lives at the top-level /interface/ route instead.
 */
export const PORTAL_NAV_ITEMS: PortalNavItem[] = [
  {
    key: 'status',
    labelKey: 'nav_status',
    icon: 'M3 12l9-8 9 8v8a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    permission: 'module_locations_enabled',
    segment: 'status',
  },
  {
    key: 'objekt',
    labelKey: 'nav_objekt',
    icon: 'M5 3h9l5 5v13H5zM14 3v5h5M9 13h6M9 17h4',
    permission: 'module_locations_enabled',
    segment: 'object',
  },
  {
    key: 'analyse',
    labelKey: 'nav_analyse',
    icon: 'M4 19V5M4 19h16M8 15l3-4 3 3 4-6',
    permission: 'module_measurements_enabled',
    segment: 'analysis',
  },
  {
    key: 'benach',
    labelKey: 'nav_benach',
    icon: 'M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7M10.3 20a2 2 0 0 0 3.4 0',
    permission: 'module_notifications_enabled',
    segment: 'notifications',
  },
  {
    key: 'rechte',
    labelKey: 'nav_rechte',
    icon: 'M9 8a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 8zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 6.4a3 3 0 0 1 0 5.6M21 20c0-2.1-.9-3.9-2.3-5',
    permission: 'module_locations_enabled',
    segment: 'permissions',
  },
  {
    key: 'einstell',
    labelKey: 'nav_einstell',
    icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2 1.3-1.6 3-2.3-.7-1.7 1-.4 2.4h-3.4l-.4-2.4-1.7-1-2.3.7L3.6 13.3 5.6 12l-2-1.3 1.6-3 2.3.7 1.7-1L9.6 5h3.4l.4 2.4 1.7 1 2.3-.7 1.6 3z',
    permission: 'module_locations_enabled',
    segment: 'settings',
  },
];

/**
 * The portal of a location lives under its project number -
 * /project/<project_id>/<segment> opens the project's main location
 * (backend helper/project_portal.py). Numbers aren't unique: every other
 * location - a duplicate, one without a number - keeps its pk URL
 * /location/<pk>/<segment>; the portal opens both and forwards a pk URL of a
 * main location to its number (LocationPortalLayout).
 */
export const projectPath = (projectId: string | number, segment = 'status', search = '') =>
  `/project/${projectId}/${segment}${search ? `?${search.replace(/^\?/, '')}` : ''}`;

/** A location as the links need it: pk, number and - known by its detail
 * answer only - whether its number opens it (project_main). */
export type PortalLocation = {
  id?: number | null;
  project_id?: number | null;
  project_main?: boolean | null;
};

/** A location's page: by its project number, by pk where the number doesn't
 * open it (project_main false) or it has none. */
export const locationPagePath = (location: PortalLocation, segment = 'status', search = '') =>
  location.project_id != null && location.project_main !== false
    ? projectPath(location.project_id, segment, search)
    : `/location/${location.id}/${segment}${search ? `?${search.replace(/^\?/, '')}` : ''}`;

export const portalNavPath = (item: PortalNavItem, projectId: string | number) =>
  projectPath(projectId, item.segment);

/** /project/<nr>/<segment> or /location/<pk>/<segment>. */
const PORTAL_PAGE = /^\/(project|location)\/(\d+)\/([^/?#]+)/;

/** The portal tab of a location page (`/project/<nr>/<segment>`, `/location/<pk>/<segment>`), else null. */
export const portalTabOf = (pathname: string): PortalNavItem | null => {
  const segment = PORTAL_PAGE.exec(pathname)?.[3];
  return PORTAL_NAV_ITEMS.find((item) => item.segment === segment) ?? null;
};

/** Location pages besides the portal tabs (CoreRoutes). */
const LOCATION_PAGE_SEGMENTS = new Set([
  ...PORTAL_NAV_ITEMS.map((item) => item.segment),
  'heatplot',
  'alarms',
]);

const positive = (value: string | null | undefined) => {
  const number = Number(value);
  return value && Number.isInteger(number) && number > 0 ? number : null;
};

/** The project number of the portal page open: /project/<project_id>/...; else null. */
export const openProjectId = (pathname: string): number | null =>
  positive(/^\/project\/(\d+)\//.exec(pathname)?.[1]);

/** The location (pk) the page shows: /location/<pk>/... or ?location=<pk>; else null. */
export const openLocationId = (pathname: string, search = ''): number | null =>
  positive(/^\/location\/(\d+)\//.exec(pathname)?.[1] ?? new URLSearchParams(search).get('location'));

/** Whether `location` is the one the page shows (/project/<nr>/ by number, else by pk). */
export const isOpenLocation = (location: PortalLocation, pathname: string, search = '') => {
  const projectId = openProjectId(pathname);
  return projectId != null
    ? location.project_id === projectId
    : location.id != null && location.id === openLocationId(pathname, search);
};

/**
 * Where a switch to `location` leads (favorites bar): the open page with the
 * other location - /project/12/object -> /project/7/object,
 * /checklist/location/?location=12 -> ?location=7 (pks) - so staff move
 * between locations without leaving the page. Anywhere else the status page
 * (every user may open it). Deeper paths and other parameters are dropped:
 * they belong to the open location (a plan, a sensor).
 */
export const switchLocationPath = (pathname: string, location: PortalLocation, search = '') => {
  const segment = PORTAL_PAGE.exec(pathname)?.[3];
  if (segment && LOCATION_PAGE_SEGMENTS.has(segment)) {
    return locationPagePath(location, segment);
  }
  if (new URLSearchParams(search).has('location')) {
    return `${pathname}?location=${location.id}`;
  }
  return locationPagePath(location);
};
