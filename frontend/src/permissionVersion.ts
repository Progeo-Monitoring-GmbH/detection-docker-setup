/**
 * The version of the logged-in user's permissions, from every API answer
 * (X-Permissions-Version, backend helper/permission_version.py). The module
 * permissions are kept per login token (usePermissions) - a new version
 * means they changed (granted, taken away, staff flag): the permission hooks
 * fetch them again right away instead of at the next login.
 */

export const PERMISSIONS_HEADER = 'x-permissions-version';

type Listener = () => void;

let known: string | null = null;
const listeners = new Set<Listener>();

/** The version of an answer - a change from the one seen so far tells the listeners. */
export const notePermissionsVersion = (value: unknown) => {
  if (typeof value !== 'string' || !value) {
    return;
  }
  const changed = known !== null && known !== value;
  known = value;
  if (changed) {
    listeners.forEach((listener) => listener());
  }
};

/** Called whenever the permissions changed (returns the unsubscribe). */
export const onPermissionsChanged = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Logged out / another user: the next version seen is the new baseline. */
export const resetPermissionsVersion = () => {
  known = null;
};
