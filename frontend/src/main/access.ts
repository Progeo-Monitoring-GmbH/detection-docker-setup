import { useAuth } from '../../hooks/CoreAuthProvider';
import usePermissions from '../../hooks/usePermissions';
import type { PortalNavItem } from './portalNav';

/**
 * Who may see what - the one place the frontend decides it. The sidebar, the
 * route guards (RequireAccess) and the views all ask these rules, so a page
 * can't be hidden in one place and open in another.
 *
 * This only shapes the UI: anyone can flip the flags in their browser. The
 * backend checks every request itself (is_staff_admin, superuser checks,
 * require_module_permissions).
 *
 * is_staff and is_superuser are separate roles: STAFF lets both in (the
 * backend's is_staff_admin), SUPERUSER only superusers.
 */

export type AccessContext = {
  /** The `is_staff` flag alone. */
  isStaff: boolean;
  isSuperuser: boolean;
  /** Module permission - always true for a superuser (usePermissions). */
  hasPermission: (code: string) => boolean;
};

export type AccessRule = (access: AccessContext) => boolean;

export const ANY_USER: AccessRule = () => true;
export const SUPERUSER: AccessRule = ({ isSuperuser }) => isSuperuser;
/** Staff or superuser - the backend's is_staff_admin. */
export const STAFF: AccessRule = ({ isStaff, isSuperuser }) =>
  isStaff || isSuperuser;
export const permission =
  (code: string): AccessRule =>
  ({ hasPermission }) =>
    hasPermission(code);
export const allOf =
  (...rules: AccessRule[]): AccessRule =>
  (access) =>
    rules.every((rule) => rule(access));
export const anyOf =
  (...rules: AccessRule[]): AccessRule =>
  (access) =>
    rules.some((rule) => rule(access));

/**
 * Access of every route below AppLayout/LocationPortalLayout (CoreRoutes),
 * keyed by its exact path. A path missing here lets nobody in, and
 * access.spec.ts fails for a route without a guard.
 */
export const APP_ROUTE_ACCESS = {
  '/location/overview/': permission('module_locations_enabled'),
  '/developer': SUPERUSER,
  '/device/overview': SUPERUSER,
  '/alarms/': SUPERUSER,
  '/alarms/report/': SUPERUSER,
  '/location/:id/heatplot': permission('module_measurements_enabled'),
  '/locations/:id/heatplot': permission('module_measurements_enabled'),
  '/location/:id/heatmap2d': permission('module_measurements_enabled'),
  '/location/:id/alarms': permission('module_measurements_enabled'),
  // Only redirects - its targets are guarded.
  '/device/:id/update/': ANY_USER,
  // Opened from the device overview.
  '/device/:id/editor/': SUPERUSER,
  // Staff always (like the backend's require_module_permissions), users with the permission.
  '/device/provision/': anyOf(STAFF, permission('module_devices_provision')),
  '/device/statistics/': allOf(STAFF, permission('module_devices_enabled')),
  // Opened from the device overview and the device statistics.
  '/device/:id/detail': STAFF,
  '/admin/panel/': SUPERUSER,
  '/staff/': STAFF,
  '/escalations/': STAFF,
  '/escalations/:id': STAFF,
  '/backup/:account/overview/': permission('module_backup_enabled'),
  '/lageplan/wizard/': SUPERUSER,
  '/map/': SUPERUSER,
  // Object management - ProGeo-Admins (roleModel: superusers).
  '/verwaltung/': SUPERUSER,
  '/anlegen/': SUPERUSER,
  // The landing page forwards to what the user may see.
  '*': ANY_USER,
} satisfies Record<string, AccessRule>;

export type AppRoutePath = keyof typeof APP_ROUTE_ACCESS;

const NOBODY: AccessRule = () => false;

/** The rule of a route path - a path missing in APP_ROUTE_ACCESS lets nobody in. */
export const routeRule = (path: string): AccessRule =>
  (APP_ROUTE_ACCESS as Record<string, AccessRule>)[path] ?? NOBODY;

/** The per-object portal pages: "Einstellungen" is superuser-only. */
export const portalItemRule = (item: PortalNavItem): AccessRule =>
  item.key === 'einstell' ? SUPERUSER : permission(item.permission);

/** The staff flags of a JWT payload (auth.user). */
export const staffFlags = (user: unknown) => {
  const flags = user as { is_staff?: boolean; is_superuser?: boolean } | null;
  const isStaff = Boolean(flags?.is_staff);
  const isSuperuser = Boolean(flags?.is_superuser);
  return { isStaff, isSuperuser, isStaffOrSuperuser: isStaff || isSuperuser };
};

/**
 * The staff flags as the UI shows them - cleared while a staff member views
 * the portal as a normal user (viewAsUser). Enough where no module
 * permission is involved.
 */
export const useStaffFlags = () => staffFlags(useAuth()?.user);

/** Staff flags, module permissions and `can(rule)` for the current user. */
export const useAccess = () => {
  const flags = useStaffFlags();
  const { hasPermission, isLoading } = usePermissions();
  const context: AccessContext = {
    isStaff: flags.isStaff,
    isSuperuser: flags.isSuperuser,
    hasPermission,
  };
  return {
    ...flags,
    hasPermission,
    isLoading,
    can: (rule: AccessRule) => rule(context),
  };
};
