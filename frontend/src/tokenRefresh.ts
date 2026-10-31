import axios from 'axios';
import { jwtDecode, type JwtPayload } from 'jwt-decode';
import { getBackendBaseUrl } from './backendUrl';

/**
 * Access/refresh token handling shared by CoreAuthProvider and the axios
 * interceptor.
 *
 * SimpleJWT rotates refresh tokens (ROTATE_REFRESH_TOKENS + blacklist after
 * rotation): the refresh response contains both a new `access` and a new
 * `refresh`, so both are stored - keeping the old refresh would log the user
 * out on the next refresh.
 */

export const ACCESS_TOKEN_KEY = 'authToken';
export const REFRESH_TOKEN_KEY = 'refreshToken';
const REFRESH_URL = `${getBackendBaseUrl()}/api/token/refresh/`;

type TokenListener = (access: string, refresh: string) => void;
const listeners = new Set<TokenListener>();

let refreshInFlight: Promise<string | null> | null = null;

const storage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};

export const readStoredTokens = () => {
  const store = storage();
  return {
    access: store?.getItem(ACCESS_TOKEN_KEY) || '',
    refresh: store?.getItem(REFRESH_TOKEN_KEY) || '',
  };
};

export const storeTokens = (access: string, refresh?: string | null) => {
  const store = storage();
  if (!store) {
    return;
  }
  if (access) {
    store.setItem(ACCESS_TOKEN_KEY, access);
  } else {
    store.removeItem(ACCESS_TOKEN_KEY);
  }
  if (refresh) {
    store.setItem(REFRESH_TOKEN_KEY, refresh);
  } else {
    store.removeItem(REFRESH_TOKEN_KEY);
  }
};

export const clearStoredTokens = () => storeTokens('', '');

export const onTokensRefreshed = (listener: TokenListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const notify = (access: string, refresh: string) => {
  listeners.forEach((listener) => listener(access, refresh));
};

/** Whether an access token is close enough to expiry to renew it early. */
export const shouldRefreshAccessToken = (token: string, marginMs = 5 * 60 * 1000) => {
  if (!token) {
    return false;
  }
  try {
    const { exp } = jwtDecode<JwtPayload>(token);
    return exp != null && exp * 1000 - Date.now() <= marginMs;
  } catch {
    return false;
  }
};

/**
 * Renew the access token with the stored (or given) refresh token.
 *
 * Concurrent calls share one request. Returns the new access token, or null
 * when there is no refresh token / the refresh was refused. On success the
 * rotated tokens are persisted and listeners (CoreAuthProvider) are notified.
 */
export const refreshAccessToken = async (
  explicitRefresh?: string,
): Promise<string | null> => {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  const refresh = (explicitRefresh || readStoredTokens().refresh).trim();
  if (!refresh) {
    return null;
  }

  refreshInFlight = (async () => {
    try {
      let response;
      try {
        response = await axios.post(REFRESH_URL, { refresh });
      } catch (error) {
        // Another tab may have rotated the refresh token a moment ago (the
        // old one is blacklisted then). Try the newly stored one once; this
        // keeps an active multi-tab session from being logged out.
        const latest = readStoredTokens().refresh;
        if (!latest || latest === refresh) {
          return null;
        }
        response = await axios.post(REFRESH_URL, { refresh: latest });
      }
      const access = String(response?.data?.access || '');
      if (!access) {
        return null;
      }
      // SimpleJWT returns a rotated refresh token; keep the old one only when
      // the backend did not rotate (e.g. ROTATE_REFRESH_TOKENS disabled).
      const nextRefresh = String(response?.data?.refresh || readStoredTokens().refresh);
      storeTokens(access, nextRefresh);
      notify(access, nextRefresh);
      return access;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
};
