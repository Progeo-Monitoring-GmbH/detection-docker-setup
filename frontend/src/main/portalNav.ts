export type PortalNavItem = {
  key: 'status' | 'objekt' | 'analyse' | 'benach' | 'rechte' | 'einstell' | 'schnittstelle';
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
 * "schnittstelle" has no equivalent in the mockup (SMTP/Modbus/SMS config) -
 * kept here so existing functionality still has a home in the new sidebar.
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
    segment: 'objekt',
  },
  {
    key: 'analyse',
    labelKey: 'nav_analyse',
    icon: 'M4 19V5M4 19h16M8 15l3-4 3 3 4-6',
    permission: 'module_measurements_enabled',
    segment: 'analyse',
  },
  {
    key: 'benach',
    labelKey: 'nav_benach',
    icon: 'M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7M10.3 20a2 2 0 0 0 3.4 0',
    permission: 'module_notifications_enabled',
    segment: 'benachrichtigungen',
  },
  {
    key: 'rechte',
    labelKey: 'nav_rechte',
    icon: 'M9 8a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 8zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 6.4a3 3 0 0 1 0 5.6M21 20c0-2.1-.9-3.9-2.3-5',
    permission: 'module_locations_enabled',
    segment: 'rechte',
  },
  {
    key: 'einstell',
    labelKey: 'nav_einstell',
    icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2 1.3-1.6 3-2.3-.7-1.7 1-.4 2.4h-3.4l-.4-2.4-1.7-1-2.3.7L3.6 13.3 5.6 12l-2-1.3 1.6-3 2.3.7 1.7-1L9.6 5h3.4l.4 2.4 1.7 1 2.3-.7 1.6 3z',
    permission: 'module_locations_enabled',
    segment: 'einstellungen',
  },
  {
    key: 'schnittstelle',
    labelKey: 'nav_schnittstelle',
    icon: 'M9 2v4M15 2v4M6 8h12v4a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8zM9 20v-2M15 20v-2',
    permission: 'module_interface_enabled',
    segment: 'schnittstelle',
  },
];

export const portalNavPath = (item: PortalNavItem, id: string | number) =>
  `/location/${id}/${item.segment}`;
