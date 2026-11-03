/**
 * The chat login (Matrix -> MAS -> the portal as OpenID Connect provider,
 * progeo/oidc.py) sends users without a portal session to
 * /login?forward=<the backend's /auth/oidc/authorize/ URL>. After the login
 * that URL needs a full page load - it is a backend route, not an SPA one.
 * Only same-origin authorize URLs count, so `forward` can't redirect
 * anywhere else.
 */
const OIDC_AUTHORIZE_PATH = '/auth/oidc/authorize/';

const parse = (forward: string | null | undefined, origin: string): URL | null => {
  if (!forward) {
    return null;
  }
  try {
    const url = new URL(forward, origin);
    return url.origin === origin && url.pathname === OIDC_AUTHORIZE_PATH ? url : null;
  } catch {
    return null;
  }
};

/** The authorize URL to load after the login, or null for a normal SPA forward. */
export const oidcForwardUrl = (
  forward: string | null | undefined,
  origin: string = window.location.origin,
): string | null => parse(forward, origin)?.toString() ?? null;

/** The user name the chat app passed along (QR code login link), or ''. */
export const oidcLoginHint = (
  forward: string | null | undefined,
  origin: string = window.location.origin,
): string => parse(forward, origin)?.searchParams.get('login_hint') ?? '';
