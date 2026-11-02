import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import { staffFlags } from './access';

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
  const { isStaff, isSuperuser } = staffFlags(auth?.user);

  if (isSuperuser) {
    return 'progeo-admin';
  }
  if (isStaff || hasPermission('module_locations_edit')) {
    return 'kundenadmin';
  }
  return 'nutzer';
};
