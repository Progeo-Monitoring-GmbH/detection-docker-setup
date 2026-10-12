import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';

export type ProgeoRole = 'progeo-admin' | 'kundenadmin' | 'nutzer';

/**
 * Maps the mockup's three role labels (Nutzer / Kundenadmin / ProGeo-Admin)
 * onto the existing auth/permission model - there is no backend concept of
 * these roles directly, so this is an explicit approximation:
 *  - progeo-admin: superusers (`is_superuser`).
 *  - kundenadmin: staff (`is_staff`), and any other user who can edit this
 *    location (`module_locations_edit`).
 *  - nutzer: everyone else (view-only).
 * Staff and superuser are deliberately distinct: staff-only UI that is not
 * about the role (e.g. the Staff-Admin link) checks `is_staff` itself.
 */
export const useProgeoRole = (): ProgeoRole => {
  const auth = useAuth();
  const { hasPermission } = usePermissions();
  const user = auth?.user as {
    is_staff?: boolean;
    is_superuser?: boolean;
  } | null;

  if (user?.is_superuser) {
    return 'progeo-admin';
  }
  if (user?.is_staff || hasPermission('module_locations_edit')) {
    return 'kundenadmin';
  }
  return 'nutzer';
};
