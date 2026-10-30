import { jwtDecode } from 'jwt-decode';
import type { AuthContextType } from '../../hooks/CoreAuthProvider';

/**
 * "Log in as" (superusers, Benutzerverwaltung): the backend issues an access
 * token of the target user with the claims `impersonator`/`impersonator_id`
 * (StaffUserImpersonateView) - no refresh token, it ends with the access
 * token. The superuser's own tokens are kept here so ImpersonationBanner can
 * switch back. Credential changes and user administration are refused with
 * such a token (ImpersonationMiddleware, `impersonation` in the body) -
 * axiosConfig shows a hint for those instead of the login page.
 */

/** localStorage key of the superuser's own tokens while logged in as someone else. */
const OWN_TOKENS_KEY = 'impersonatorTokens';

type OwnTokens = { access: string; refresh: string };

/** JWT claim `impersonator`: who is logged in as this user, else null. */
export const impersonatorOf = (user: unknown): string | null =>
  (user as { impersonator?: string } | null)?.impersonator || null;

/** A write the backend refused because the session is a "log in as" one. */
export const isImpersonationBlockedError = (error: unknown) =>
  Boolean(
    (error as { response?: { data?: { impersonation?: boolean } } })?.response
      ?.data?.impersonation,
  );

const isExpired = (token: string) => {
  try {
    const { exp } = jwtDecode(token);
    return exp != null && exp * 1000 <= Date.now();
  } catch {
    return true;
  }
};

export const clearImpersonation = () => {
  try {
    localStorage.removeItem(OWN_TOKENS_KEY);
  } catch {
    // Storage unavailable: nothing kept.
  }
};

const takeOwnTokens = (): OwnTokens | null => {
  try {
    const raw = localStorage.getItem(OWN_TOKENS_KEY);
    clearImpersonation();
    return raw ? (JSON.parse(raw) as OwnTokens) : null;
  } catch {
    return null;
  }
};

/** Switch to the target's `access` token, keeping the own ones for the way back. */
export const startImpersonation = (auth: AuthContextType, access: string) => {
  try {
    localStorage.setItem(
      OWN_TOKENS_KEY,
      JSON.stringify({ access: auth.token, refresh: auth.refreshToken }),
    );
  } catch {
    // Storage unavailable: "back" then ends on the login page.
  }
  auth.loginWithTokens(access, '');
};

/**
 * Back to the superuser's own session - or the login page if it expired
 * meanwhile (it is never renewed from the impersonation token).
 */
export const stopImpersonation = (auth: AuthContextType, forward: string) => {
  const own = takeOwnTokens();
  if (own?.access && !isExpired(own.access)) {
    auth.loginWithTokens(own.access, own.refresh || '');
    auth.navigate(forward);
  } else {
    auth.logoutAction(forward);
  }
};
