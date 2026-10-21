/**
 * The public, read-only demo: a demo link (/demo/login/<token>) logs in the
 * "demo" user, who then uses the regular portal. The backend refuses every
 * write of that user (DemoReadOnlyMiddleware) with `demo_read_only` in the
 * body - axiosConfig shows a hint for those instead of the login page.
 */

/** localStorage key of the demo link token - lets an expired session log in again. */
export const DEMO_TOKEN_KEY = 'demoToken';

/** JWT claim `is_demo` (ProgeoTokenObtainPairSerializer). */
export const isDemoUser = (user: unknown) =>
  Boolean((user as { is_demo?: boolean } | null)?.is_demo);

/** A write the backend refused because the user is the demo user. */
export const isDemoReadOnlyError = (error: unknown) =>
  Boolean(
    (error as { response?: { data?: { demo_read_only?: boolean } } })?.response
      ?.data?.demo_read_only,
  );

export const getDemoToken = () => {
  try {
    return localStorage.getItem(DEMO_TOKEN_KEY);
  } catch {
    return null;
  }
};

export const setDemoToken = (token: string | null) => {
  try {
    if (token) {
      localStorage.setItem(DEMO_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(DEMO_TOKEN_KEY);
    }
  } catch {
    // Storage unavailable: an expired demo session then ends on the login page.
  }
};

/** Where an expired/invalid session goes: the demo link again for demo users. */
export const loginPathFor = (user: unknown, forward: string) => {
  const demoToken = isDemoUser(user) ? getDemoToken() : null;
  return demoToken
    ? `/demo/login/${demoToken}?forward=${encodeURIComponent(forward)}`
    : `/login?forward=${forward}`;
};
