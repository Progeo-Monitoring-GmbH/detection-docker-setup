import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';

export type ProgeoRole = 'progeo-admin' | 'kundenadmin' | 'nutzer';

/**
 * Maps the mockup's three role labels (Nutzer / Kundenadmin / ProGeo-Admin)
 * onto the existing auth/permission model - there is no backend concept of
 * these roles directly, so this is an explicit approximation:
 *  - progeo-admin: ProGeo staff (`is_staff`, the same check `Navbar.jsx` and
 *    `StaffAdmin.tsx` already use for staff-only UI).
 *  - kundenadmin: a non-staff user who can edit this location
 *    (`module_locations_edit`).
 *  - nutzer: everyone else (view-only).
 * `usePermissions()`'s `is_superuser` bypass already flows through
 * `hasPermission`, so it doesn't need to be duplicated here.
 */
export const useProgeoRole = (): ProgeoRole => {
  const auth = useAuth();
  const { hasPermission } = usePermissions();
  const isStaff = Boolean((auth?.user as { is_staff?: boolean } | null)?.is_staff);

  if (isStaff) {
    return 'progeo-admin';
  }
  if (hasPermission('module_locations_edit')) {
    return 'kundenadmin';
  }
  return 'nutzer';
};
