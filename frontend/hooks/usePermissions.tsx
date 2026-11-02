import { useEffect, useState } from 'react';
import axiosConfig from '../src/axiosConfig';
import { AuthContextType, useAuth } from './CoreAuthProvider';

export type ModulePermissions = Record<string, boolean>;

type ModulePermissionPayload = {
  user_id?: number;
  username?: string;
  permissions: ModulePermissions;
  enabled: string[];
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

const PERMISSION_ROUTE_MAP: Record<string, PermissionRouteConfig> = {
  module_devices_enabled: {
    target: '/device/overview/',
    allowedPrefixes: ['/device/overview', '/device/'],
  },
  module_locations_enabled: {
    target: '/location/overview/',
    allowedPrefixes: ['/location/overview', '/location/'],
  },
  module_measurements_enabled: {
    target: '/device/measure/',
    allowedPrefixes: ['/device/measure'],
  },
  module_imei_enabled: {
    target: '/devices/imei/display/',
    allowedPrefixes: ['/devices/imei/display'],
  },
  module_backup_enabled: {
    target: '/backup/1/overview/',
    allowedPrefixes: ['/backup/'],
  },
  module_docker_enabled: {
    target: '/docker/',
    allowedPrefixes: ['/docker/'],
  },
  module_admin_enabled: {
    target: '/admin/panel/',
    allowedPrefixes: ['/admin/panel/', '/aadmin'],
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

/**
 * The token plus the view: as a normal user (viewAsUser) a superuser gets
 * only the permissions granted to it, not all of them.
 */
const permissionCacheKey = (auth: AuthContextType, token: string) =>
  token && auth?.viewAsUser ? `${token}|as_user` : token;

const fetchPermissionPayload = async (auth: AuthContextType, token: string) => {
  const cacheKey = permissionCacheKey(auth, token);
  if (!token) {
    clearPermissionsCache();
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
      const payload = await fetchPermissionPayload(auth, token);
      setPermissionPayload(payload);
      setError(null);
      setIsLoading(false);
      return payload;
    },
  };
};

export default usePermissions;
