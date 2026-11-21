import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import { useAccess } from './access';
import { isDemoUser } from './demo';

/** What the status page lets the user do (`demo`: the public demo view). */
export const useStatusAccess = (demo: boolean) => {
  const auth = useAuth();
  const { hasPermission, isStaffOrSuperuser } = useAccess();
  // The demo user sees the regular portal, but no actions with real side
  // effects (a measurement request reaches the devices).
  const readOnlyDemo = demo || isDemoUser(auth.user);
  const djangoAdmin = !readOnlyDemo && isStaffOrSuperuser;
  return {
    readOnlyDemo,
    // Battery charts are device maintenance - staff (and superusers) only.
    isStaff: !demo && isStaffOrSuperuser,
    canEditInDjango:
      djangoAdmin && hasPermission('module_locations_django_edit'),
    canDeleteInDjango:
      djangoAdmin && hasPermission('module_locations_django_delete'),
  };
};
