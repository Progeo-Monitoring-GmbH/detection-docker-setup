import { useEffect, useState } from 'react';
import axiosConfig from '../src/axiosConfig';
import { AuthContextType, useAuth } from './CoreAuthProvider';

export type ModulePermissions = Record<string, boolean>;

export type ModulePermissionPayload = {
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

export const hasModulePermission = (
  permissions: ModulePermissions,
  code: string,
  isAdmin = false,
) => {
  return getPermissionValue(permissions, code, isAdmin);
};

export const hasAnyModulePermission = (
  permissions: ModulePermissions,
  codes: string[] = [],
  isAdmin = false,
) => {
  if (isAdmin) {
    return true;
  }

  return codes.some((code) => getPermissionValue(permissions, code));
};

export const hasAllModulePermissions = (
  permissions: ModulePermissions,
  codes: string[] = [],
  isAdmin = false,
) => {
  if (isAdmin) {
    return true;
  }

  return codes.every((code) => getPermissionValue(permissions, code));
};

export const getEnabledModulePermissions = (permissions: ModulePermissions) => {
  return Object.keys(permissions).filter((code) => permissions[code]);
};

export const getPermissionRoute = (code: string) => {
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

export const clearPermissionsCache = () => {
  cachedToken = '';
  cachedPermissionPayload = null;
  pendingPermissionRequest = null;
};

const fetchPermissionPayload = async (auth: AuthContextType, token: string) => {
  if (!token) {
    clearPermissionsCache();
    return EMPTY_PERMISSIONS;
  }

  if (cachedPermissionPayload && cachedToken === token) {
    return cachedPermissionPayload;
  }

  if (pendingPermissionRequest && cachedToken === token) {
    return pendingPermissionRequest;
  }

  cachedToken = token;
  pendingPermissionRequest = new Promise((resolve, reject) => {
    axiosConfig.perform_get(
      auth,
      '/api/auth-support/module-permissions/',
      (response: { data?: PermissionResponsePayload }) => {
        const nextPayload = normalizePermissionPayload(response?.data);
        cachedPermissionPayload = nextPayload;
        pendingPermissionRequest = null;
        resolve(nextPayload);
      },
      (error) => {
        pendingPermissionRequest = null;
        cachedPermissionPayload = null;
        reject(error);
      },
    );
  });

  return pendingPermissionRequest;
};

export const usePermissions = () => {
  const auth = useAuth();
  const token = auth?.token || '';
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

    if (cachedPermissionPayload && cachedToken === token) {
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
      const payload = await fetchPermissionPayload(auth, token);
      setPermissionPayload(payload);
      setError(null);
      setIsLoading(false);
      return payload;
    },
  };
};

export default usePermissions;
