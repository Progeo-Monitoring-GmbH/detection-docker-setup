/**
 * "Show as normal user" (TopBar): a staff member/superuser sees the portal
 * the way a normal user does. CoreAuthProvider clears `is_staff` and
 * `is_superuser` of `auth.user` while it is on, so every staff check in the
 * views hides its staff UI without knowing about this mode; usePermissions
 * asks the backend for the module permissions without the superuser
 * shortcut. Only the UI changes - the backend still answers as staff.
 */

/** localStorage key of the flag - cleared on login and logout. */
const VIEW_AS_USER_KEY = 'viewAsUser';

type StaffFlags = { is_staff?: boolean; is_superuser?: boolean } | null;

/** The real flags of the JWT: may this user switch to the normal-user view? */
export const isStaffAccount = (user: unknown) => {
  const flags = user as StaffFlags;
  return Boolean(flags?.is_staff || flags?.is_superuser);
};

/** `user` as a normal user sees it: without the staff flags. */
export const asNormalUser = <T extends object>(user: T): T => ({
  ...user,
  is_staff: false,
  is_superuser: false,
});

export const readViewAsUser = () => {
  try {
    return localStorage.getItem(VIEW_AS_USER_KEY) === '1';
  } catch {
    return false;
  }
};

export const storeViewAsUser = (on: boolean) => {
  try {
    if (on) {
      localStorage.setItem(VIEW_AS_USER_KEY, '1');
    } else {
      localStorage.removeItem(VIEW_AS_USER_KEY);
    }
  } catch {
    // Storage unavailable: the mode lasts until the next reload.
  }
};
