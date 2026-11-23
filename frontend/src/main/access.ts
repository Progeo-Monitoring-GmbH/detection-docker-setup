import { useAuth } from '../../hooks/CoreAuthProvider';
import usePermissions from '../../hooks/usePermissions';
import type { PortalNavItem } from './portalNav';

/**
 * Who may see what - the one place the frontend decides it. The sidebar, the
 * route guards (RequireAccess) and the views all ask these rules, so a page
 * can't be hidden in one place and open in another.
 *
 * This only shapes the UI: anyone can flip the flags in their browser. The
 * backend independently enforces the corresponding role and permission
 * requirements on every request.
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

const ANY_USER: AccessRule = () => true;
const SUPERUSER: AccessRule = ({ isSuperuser }) => isSuperuser;
/** Staff or superuser - the backend's is_staff_admin. */
const STAFF: AccessRule = ({ isStaff, isSuperuser }) => isStaff || isSuperuser;
const permission =
  (code: string): AccessRule =>
  ({ hasPermission }) =>
    hasPermission(code);
const allOf =
  (...rules: AccessRule[]): AccessRule =>
  (access) =>
    rules.every((rule) => rule(access));
const anyOf =
  (...rules: AccessRule[]): AccessRule =>
  (access) =>
    rules.some((rule) => rule(access));
const staffPermission = (code: string): AccessRule =>
  allOf(STAFF, permission(code));
/** A customer admin: manages the users of their own account(s) - no staff
 * (staff manage everyone; the backend's _is_customer_admin). */
export const CUSTOMER_ADMIN: AccessRule = (access) =>
  !STAFF(access) && access.hasPermission('module_customer_admin_enabled');

/**
 * Access of every route below AppLayout/LocationPortalLayout (CoreRoutes),
 * keyed by its exact path. A path missing here lets nobody in, and
 * access.spec.ts fails for a route without a guard.
 */
export const APP_ROUTE_ACCESS = {
  '/location/overview/': permission('module_locations_enabled'),
  '/developer': SUPERUSER,
  // Also the device setup (formerly /device/provision/): staff always (like
  // the backend's require_module_permissions), users with the permission.
  '/device/overview': anyOf(STAFF, permission('module_devices_provision')),
  '/alarms/': permission('module_alarms_enabled'),
  '/alarms/report/': permission('module_reports_enabled'),
  // Only redirects - its targets are guarded.
  '/device/:id/update/': ANY_USER,
  // Opened from the device overview.
  '/device/statistics/': allOf(STAFF, permission('module_devices_enabled')),
  // "Is the location ready?" - the readiness checklist (staff, like its endpoints).
  '/checklist/location/': STAFF,
  '/admin/panel/': staffPermission('module_admin_panel'),
  // Staff - and customer admins, who see only the users table there: the
  // customers of their own account(s) (the backend's _managed_users).
  '/staff/': anyOf(staffPermission('module_admin_staff_enabled'), CUSTOMER_ADMIN),
  // Database usage and user activity (main/staff/).
  '/insights/databases/': staffPermission('module_admin_insights'),
  '/insights/activity/': staffPermission('module_admin_insights'),
  // System-wide interface config; the cards check module_interface_* themselves.
  '/interface/': permission('module_interface_enabled'),
  '/escalations/': staffPermission('module_escalations_enabled'),
  // The screenshots of a build and their review comments (e2e_screenshots).
  '/review/screens/': staffPermission('module_admin_screen_review'),
  // The findings of fine_tune_thresholds: pick and apply alarm thresholds.
  '/staff/thresholds/': staffPermission('module_admin_thresholds'),
  '/escalations/:id': staffPermission('module_escalations_enabled'),
  // Staff only (as the backend's BackupViewSet), whatever a customer holds.
  '/backup/:account/overview/': allOf(
    STAFF,
    permission('module_backup_enabled'),
  ),
  '/site-plan/wizard/': STAFF,
  '/map/': STAFF,
  // Object management - ProGeo-Admins (roleModel: superusers).
  '/management/': SUPERUSER,
  '/create/': SUPERUSER,
  // The landing page forwards to what the user may see.
  '*': ANY_USER,
} satisfies Record<string, AccessRule>;

export type AppRoutePath = keyof typeof APP_ROUTE_ACCESS;

const NOBODY: AccessRule = () => false;

/** The rule of a route path - a path missing in APP_ROUTE_ACCESS lets nobody in. */
export const routeRule = (path: string): AccessRule =>
  (APP_ROUTE_ACCESS as Record<string, AccessRule>)[path] ?? NOBODY;

/**
 * The per-object portal pages: "Einstellungen" is superuser-only, the
 * "Analyse" (with its report generator) staff-only for now - both customer
 * roles (and "show as normal user") don't see it.
 */
export const portalItemRule = (item: PortalNavItem): AccessRule => {
  if (item.key === 'einstell') {
    return SUPERUSER;
  }
  if (item.key === 'analyse') {
    return allOf(STAFF, permission(item.permission));
  }
  return permission(item.permission);
};

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
const useStaffFlags = () => staffFlags(useAuth()?.user);

/** Staff flags, module permissions and `can(rule)` for the current user. */
export const useAccess = () => {
  const flags = useStaffFlags();
  const { hasPermission, isLoading, error, refreshPermissions } =
    usePermissions();
  const context: AccessContext = {
    isStaff: flags.isStaff,
    isSuperuser: flags.isSuperuser,
    hasPermission,
  };
  return {
    ...flags,
    hasPermission,
    isLoading,
    /** Loading the module permissions failed - not the same as having none. */
    error,
    refreshPermissions,
    can: (rule: AccessRule) => rule(context),
  };
};
