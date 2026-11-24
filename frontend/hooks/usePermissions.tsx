import { useEffect, useState } from 'react';
import axiosConfig from '../src/axiosConfig';
import { AuthContextType, useAuth } from './CoreAuthProvider';
import { isPendingUser } from '../src/main/pendingReview';
import { onPermissionsChanged } from '../src/permissionVersion';
import { tokenUserKey } from '../src/tokenRefresh';

export type ModulePermissions = Record<string, boolean>;

type ModulePermissionPayload = {
  user_id?: number;
  username?: string;
  permissions: ModulePermissions;
  enabled: string[];
  /** Usage analysis on for this user (normal user, ACTIVITY_TRACKING_ENABLED). */
  activity_tracking?: boolean;
};

type PermissionResponsePayload =
  Partial<ModulePermissionPayload> | null | undefined;

type PermissionRouteConfig = {
  target: string;
  allowedPrefixes: string[];
};

const EMPTY_PERMISSIONS: ModulePermissionPayload = {
  permissions: {},
  enabled: [],
};

// Token and view (see viewAsUser) the cached payload belongs to.
let cachedToken = '';
let cachedPermissionPayload: ModulePermissionPayload | null = null;
let pendingPermissionRequest: Promise<ModulePermissionPayload> | null = null;

// A user with a single module permission is sent to its page. Only pages a
// normal user may open (access.ts) - superusers are never forwarded.
const PERMISSION_ROUTE_MAP: Record<string, PermissionRouteConfig> = {
  module_locations_enabled: {
    target: '/location/overview/',
    allowedPrefixes: ['/location/overview', '/location/'],
  },
  module_backup_enabled: {
    target: '/backup/1/overview/',
    allowedPrefixes: ['/backup/'],
  },
};

const normalizePermissionPayload = (
  payload: PermissionResponsePayload,
): ModulePermissionPayload => {
  const permissions = payload?.permissions || {};

  return {
    user_id: payload?.user_id,
    username: payload?.username,
    permissions,
    enabled:
      payload?.enabled ||
      Object.keys(permissions).filter((key) => permissions[key]),
    activity_tracking: payload?.activity_tracking === true,
  };
};

const getPermissionValue = (
  permissions: ModulePermissions,
  code: string,
  isAdmin = false,
) => {
  if (isAdmin) {
    return true;
  }

  return Boolean(permissions?.[code]);
};

const hasModulePermission = (
  permissions: ModulePermissions,
  code: string,
  isAdmin = false,
) => {
  return getPermissionValue(permissions, code, isAdmin);
};

const hasAnyModulePermission = (
  permissions: ModulePermissions,
  codes: string[] = [],
  isAdmin = false,
) => {
  if (isAdmin) {
    return true;
  }

  return codes.some((code) => getPermissionValue(permissions, code));
};

const hasAllModulePermissions = (
  permissions: ModulePermissions,
  codes: string[] = [],
  isAdmin = false,
) => {
  if (isAdmin) {
    return true;
  }

  return codes.every((code) => getPermissionValue(permissions, code));
};

const getEnabledModulePermissions = (permissions: ModulePermissions) => {
  return Object.keys(permissions).filter((code) => permissions[code]);
};

const getPermissionRoute = (code: string) => {
  return PERMISSION_ROUTE_MAP[code]?.target || null;
};

export const getSinglePermissionForwardUrl = (
  permissions: ModulePermissions,
) => {
  const enabledPermissions = getEnabledModulePermissions(permissions);

  if (enabledPermissions.length !== 1) {
    return null;
  }

  return getPermissionRoute(enabledPermissions[0]);
};

const clearPermissionsCache = () => {
  cachedToken = '';
  cachedPermissionPayload = null;
  pendingPermissionRequest = null;
};

// The permissions changed (a new X-Permissions-Version, permissionVersion.ts):
// the cache is dropped once, then every mounted hook fetches - one request,
// they share it (pendingPermissionRequest).
const refetchers = new Set<() => void>();
onPermissionsChanged(() => {
  clearPermissionsCache();
  refetchers.forEach((refetch) => refetch());
});

/**
 * The user plus the view: as a normal user (viewAsUser) a superuser gets
 * a new user's default permissions plus the ones granted to it, not all.
 * Not the token - a renewed access token (every ~55 min) is the same
 * session; keying by it showed RequireAccess's spinner in place of the
 * page, which lost everything typed into it. Changed permissions arrive
 * via X-Permissions-Version.
 */
const permissionCacheKey = (auth: AuthContextType, token: string) => {
  const key = tokenUserKey(token);
  return key && auth?.viewAsUser ? `${key}|as_user` : key;
};

const fetchPermissionPayload = async (auth: AuthContextType, token: string) => {
  const cacheKey = permissionCacheKey(auth, token);
  if (!token) {
    clearPermissionsCache();
    return EMPTY_PERMISSIONS;
  }
  // Awaiting review: the backend refuses everything but the review status -
  // no permissions to ask for (the request would only be a 403).
  if (isPendingUser(auth?.user)) {
    return EMPTY_PERMISSIONS;
  }

  if (cachedPermissionPayload && cachedToken === cacheKey) {
    return cachedPermissionPayload;
  }

  if (pendingPermissionRequest && cachedToken === cacheKey) {
    return pendingPermissionRequest;
  }

  cachedToken = cacheKey;
  cachedPermissionPayload = null;
  pendingPermissionRequest = new Promise((resolve, reject) => {
    axiosConfig.perform_get(
      auth,
      auth?.viewAsUser
        ? '/api/auth-support/module-permissions/?as_user=1'
        : '/api/auth-support/module-permissions/',
      (response: { data?: PermissionResponsePayload }) => {
        const nextPayload = normalizePermissionPayload(response?.data);
        // The view may have been switched meanwhile - keep its cache.
        if (cachedToken === cacheKey) {
          cachedPermissionPayload = nextPayload;
          pendingPermissionRequest = null;
        }
        resolve(nextPayload);
      },
      (error) => {
        if (cachedToken === cacheKey) {
          pendingPermissionRequest = null;
          cachedPermissionPayload = null;
        }
        reject(error);
      },
    );
  });

  return pendingPermissionRequest;
};

type UserClaims = { user_id?: number | string } | null;

/**
 * The backend's `activity_tracking` flag of the logged-in user (from the
 * cached module permissions) - without usePermissions' forwarding of
 * single-module users, so it can run on every page (useActivityTracking).
 * It belongs to one user: false until that user's payload has loaded.
 */
export const useActivityTrackingFlag = () => {
  const auth = useAuth();
  const token = auth?.token || '';
  const userId = (auth?.user as UserClaims)?.user_id ?? null;
  const [state, setState] = useState<{ userId: unknown; on: boolean }>({
    userId: null,
    on: false,
  });

  useEffect(() => {
    if (!token) {
      return undefined;
    }
    let isMounted = true;
    fetchPermissionPayload(auth, token)
      .then(
        (payload) =>
          isMounted &&
          setState({ userId, on: Boolean(payload.activity_tracking) }),
      )
      .catch(() => isMounted && setState({ userId, on: false }));
    return () => {
      isMounted = false;
    };
  }, [auth, token, userId]);

  return (
    Boolean(token) && userId != null && state.userId === userId && state.on
  );
};

const usePermissions = () => {
  const auth = useAuth();
  const token = auth?.token || '';
  const cacheKey = permissionCacheKey(auth, token);
  const isAdmin = Boolean(
    (auth?.user as { is_superuser?: boolean } | null)?.is_superuser,
  );
  const [permissionPayload, setPermissionPayload] =
    useState<ModulePermissionPayload>(EMPTY_PERMISSIONS);
  const [isLoading, setIsLoading] = useState(Boolean(token));
  const [error, setError] = useState(null);

  useEffect(() => {
    let isMounted = true;

    if (!token) {
      clearPermissionsCache();
      setPermissionPayload(EMPTY_PERMISSIONS);
      setIsLoading(false);
      setError(null);
      return () => {
        isMounted = false;
      };
    }

    if (cachedPermissionPayload && cachedToken === cacheKey) {
      setPermissionPayload(cachedPermissionPayload);
      setIsLoading(false);
      setError(null);
      return () => {
        isMounted = false;
      };
    }

    setIsLoading(true);
    setError(null);

    fetchPermissionPayload(auth, token)
      .then((payload) => {
        if (!isMounted) {
          return;
        }

        setPermissionPayload(payload);
        setIsLoading(false);
      })
      .catch((nextError) => {
        if (!isMounted) {
          return;
        }

        setPermissionPayload(EMPTY_PERMISSIONS);
        setError(nextError);
        setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [auth, token, cacheKey]);

  // The permissions changed on the server (a new X-Permissions-Version):
  // fetched again - the sidebar and the route guards follow without a new login.
  useEffect(() => {
    if (!token) {
      return undefined;
    }
    let isMounted = true;
    const refetch = () => {
      fetchPermissionPayload(auth, token)
        .then((payload) => {
          if (isMounted) {
            setPermissionPayload(payload);
            setError(null);
          }
        })
        .catch(() => undefined);
    };
    refetchers.add(refetch);
    return () => {
      isMounted = false;
      refetchers.delete(refetch);
    };
  }, [auth, token]);

  const permissions = permissionPayload.permissions;

  useEffect(() => {
    if (isAdmin || isLoading) {
      return;
    }

    if (permissionPayload.enabled.length !== 1) {
      return;
    }

    const permissionCode = permissionPayload.enabled[0];
    const routeConfig = PERMISSION_ROUTE_MAP[permissionCode];

    if (!routeConfig) {
      return;
    }

    const currentLocation = auth?.location || '';
    const isAlreadyInAllowedArea = routeConfig.allowedPrefixes.some((prefix) =>
      currentLocation.startsWith(prefix),
    );

    if (!isAlreadyInAllowedArea) {
      auth.navigate(routeConfig.target);
    }
  }, [auth, isAdmin, isLoading, permissionPayload.enabled]);

  return {
    permissions,
    enabledPermissions: permissionPayload.enabled,
    isAdmin,
    isLoading,
    error,
    hasPermission: (code: string) =>
      hasModulePermission(permissions, code, isAdmin),
    hasAnyPermission: (codes: string[] = []) =>
      hasAnyModulePermission(permissions, codes, isAdmin),
    hasAllPermissions: (codes: string[] = []) =>
      hasAllModulePermissions(permissions, codes, isAdmin),
    refreshPermissions: async () => {
      clearPermissionsCache();
      try {
        const payload = await fetchPermissionPayload(auth, token);
        setPermissionPayload(payload);
        setError(null);
        return payload;
      } catch (nextError) {
        // Kept apart from "no permissions": the caller shows a load error.
        setError(nextError as null);
        throw nextError;
      } finally {
        setIsLoading(false);
      }
    },
  };
};

export default usePermissions;
