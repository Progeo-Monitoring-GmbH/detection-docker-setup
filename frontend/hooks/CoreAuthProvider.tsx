import axios from 'axios';
import { jwtDecode, JwtPayload } from 'jwt-decode';
import { useSnackbar } from 'notistack';
import {
  useContext,
  createContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from 'react';
import { useLocation, useNavigate } from 'react-router';
import { markLogin, startsNewSession } from '../src/activity/activityTracker';
import { getBackendBaseUrl } from '../src/backendUrl';
import { showErrorBar } from '../src/components/ui/Snackbar.jsx';
import { isDemoUser, setDemoToken } from '../src/main/demo';
import { clearImpersonation } from '../src/main/impersonation';
import { oidcForwardUrl } from '../src/main/oidcForward';
import { otpReason, OtpReason } from '../src/main/twoFactor';
import {
  asNormalUser,
  isStaffAccount,
  readViewAsUser,
  storeViewAsUser,
} from '../src/main/viewAsUser';
import {
  clearStoredTokens,
  onTokensRefreshed,
  readStoredTokens,
  refreshAccessToken,
  shouldRefreshAccessToken,
  storeTokens,
} from '../src/tokenRefresh';

type User = JwtPayload;
const intervalMin = 30;

interface AuthCredentials {
  username: string;
  password: string;
  /** The 2FA code (or a recovery code) - only for users with 2FA. */
  otp?: string;
}

/** How a login ended: an OtpReason asks the form for the 2FA code. */
type LoginOutcome = 'ok' | 'failed' | OtpReason;

interface AuthRefresh {
  isSuccess: boolean;
  newAuthToken: string;
  newAuthTokenExpireIn: number;
  newRefreshTokenExpiresIn: number;
}

export interface AuthContextType {
  token: string;
  /** Sent along with password/2FA changes - this device stays logged in. */
  refreshToken: string;
  /**
   * The JWT's claims - without is_staff/is_superuser while a staff member
   * views the portal as a normal user (viewAsUser), so staff checks need
   * nothing else.
   */
  user: User | null;
  /** The real user is staff/superuser: may switch to the normal-user view. */
  canViewAsUser: boolean;
  /** "Show as normal user" is on (TopBar). */
  viewAsUser: boolean;
  setViewAsUser: (on: boolean) => void;
  refreshApi: (refreshToken: string) => Promise<AuthRefresh>;
  loginAction: (
    data: AuthCredentials,
    forward?: string,
  ) => Promise<LoginOutcome>;
  /**
   * Adopt tokens issued elsewhere (demo/login link, password reset, a 2FA
   * change) as the current session.
   */
  loginWithTokens: (access: string, refresh: string) => void;
  logoutAction: (forward?: string) => void;
  navigate: (to: string, options?) => void;
  location: string;
}

const refreshApi = async (refreshToken) => {
  const access = await refreshAccessToken(refreshToken);
  if (!access) {
    return { isSuccess: false } as AuthRefresh;
  }
  return {
    isSuccess: true,
    newAuthToken: access,
    newAuthTokenExpireIn: intervalMin,
    newRefreshTokenExpiresIn: intervalMin * 2,
  } as AuthRefresh;
};

const defaultAuthContextValue: AuthContextType = {
  token: '',
  refreshToken: '',
  user: null,
  canViewAsUser: false,
  viewAsUser: false,
  setViewAsUser: () => {},
  refreshApi: (t) => refreshApi(t),
  loginAction: async () => 'failed',
  loginWithTokens: () => {},
  logoutAction: () => {},
  navigate: () => {},
  location: '/',
};

const AuthContext = createContext<AuthContextType>(
  defaultAuthContextValue,
);

// At call time, not import: node-environment tests import this module without `window`.
const apiUrl = () => getBackendBaseUrl();

const CoreAuthProvider = ({ children }) => {
  const [token, setToken] = useState(() => readStoredTokens().access);
  const [refreshToken, setRefreshToken] = useState(
    () => readStoredTokens().refresh,
  );
  const [user, setUser] = useState<User | null>(null);
  const [viewAsUser, setViewAsUserState] = useState(readViewAsUser);
  const location = useLocation();
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();

  useEffect(() => {
    if (token) {
      try {
        const decoded = jwtDecode<User>(token);
        setUser(decoded);
      } catch (error) {
        console.error('Failed to decode token:', error);
        setUser(null);
      }
    } else {
      setUser(null);
    }
  }, [token]);

  // The axios interceptor renews an expired access token on a 401. Adopt the
  // rotated tokens here too, so auth.token/user (and permission loading) stay
  // current.
  useEffect(
    () =>
      onTokensRefreshed((access, refresh) => {
        setToken(access);
        setRefreshToken(refresh);
      }),
    [],
  );

  // Renew shortly before expiry, so an active tab never even hits the 401
  // path. The interval also covers a laptop waking from sleep; the axios
  // interceptor is the fallback if the timer was paused.
  useEffect(() => {
    if (!token) {
      return undefined;
    }
    const renew = () => {
      if (shouldRefreshAccessToken(token)) {
        void refreshAccessToken();
      }
    };
    renew();
    const timer = window.setInterval(renew, 60 * 1000);
    return () => window.clearInterval(timer);
  }, [token]);

  const setViewAsUser = useCallback((on: boolean) => {
    storeViewAsUser(on);
    setViewAsUserState(on);
  }, []);

  const getCurrentUrl = () => {
    return location.pathname;
  };

  const logoutAction = useCallback(
    async (forward?: string) => {
      try {
        await axios.post(`${apiUrl()}/api/token/logout/`, {
          refresh: refreshToken,
        });
      } catch (error) {
        console.error(
          'Logout request failed, but proceeding with client-side logout:',
          error,
        );
      } finally {
        const wasDemo = isDemoUser(user);
        setToken('');
        setRefreshToken('');
        clearStoredTokens();
        clearImpersonation();
        setViewAsUser(false);
        if (wasDemo) {
          // Leaving the demo: no way (and no reason) to come back to it via the login form.
          setDemoToken(null);
          navigate('/login');
        } else if (forward) {
          navigate(`/login?forward=${encodeURIComponent(forward)}`);
        } else {
          navigate(`/login?forward=${encodeURIComponent(getCurrentUrl())}`);
        }
      }
    },
    [navigate, refreshToken, user, setViewAsUser],
  );

  const loginAction = useCallback(
    async (data: AuthCredentials, forward?: string): Promise<LoginOutcome> => {
      try {
        const response = await axios.post(`${apiUrl()}/api/token/`, data);
        const newToken = response.data.access;
        // Persist the refresh token too - without it a reload (or the next
        // access-token expiry) leaves an active session unable to renew.
        storeTokens(newToken, response.data.refresh);
        setToken(newToken);
        setRefreshToken(response.data.refresh);
        clearImpersonation();
        setViewAsUser(false);
        markLogin();

        // Login for the chat app (progeo/oidc.py): back to the backend.
        const oidcUrl = oidcForwardUrl(forward);
        if (oidcUrl) {
          window.location.assign(oidcUrl);
          return 'ok';
        }
        if (forward) {
          navigate(forward);
        } else {
          navigate('/');
        }
        return 'ok';
      } catch (error) {
        // Password right, 2FA code missing/wrong: the form asks for it.
        const otp = otpReason(error);
        if (otp) {
          return otp;
        }
        console.error('Login failed!', error);
        showErrorBar(enqueueSnackbar, 'Login failed!');

        await logoutAction(forward);
        return 'failed';
      }
    },
    [navigate, logoutAction, setViewAsUser], // depends on logoutAction as it is defined below
  );

  const loginWithTokens = useCallback((access: string, refresh: string) => {
    // Demo, mailed login link, password reset, access request: a login for
    // the usage analysis - a token swap of the same user or "log in as" not.
    if (startsNewSession(readStoredTokens().access, access)) {
      markLogin();
    }
    storeTokens(access, refresh);
    setToken(access);
    setRefreshToken(refresh);
  }, []);

  // One object per real change (token, user, path): views load their data in
  // effects that depend on `auth` - a new object on every render of the
  // provider made them request it again.
  const pathname = location.pathname;
  const canViewAsUser = isStaffAccount(user);
  const shownUser = useMemo(
    () => (user && canViewAsUser && viewAsUser ? asNormalUser(user) : user),
    [user, canViewAsUser, viewAsUser],
  );
  const value = useMemo(
    () => ({
      token,
      refreshToken,
      user: shownUser,
      canViewAsUser,
      viewAsUser: canViewAsUser && viewAsUser,
      setViewAsUser,
      refreshApi: () => refreshApi(refreshToken),
      loginAction,
      loginWithTokens,
      logoutAction,
      navigate: (to, options) => navigate(to, options),
      location: pathname,
    }),
    [
      token,
      shownUser,
      canViewAsUser,
      viewAsUser,
      setViewAsUser,
      refreshToken,
      loginAction,
      loginWithTokens,
      logoutAction,
      navigate,
      pathname,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export default CoreAuthProvider;

export const useAuth = (): AuthContextType => {
  return useContext(AuthContext);
};
