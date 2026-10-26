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
import { getBackendBaseUrl } from '../src/backendUrl';
import { showErrorBar } from '../src/components/ui/Snackbar.jsx';
import { isDemoUser, setDemoToken } from '../src/main/demo';
import { otpReason, OtpReason } from '../src/main/twoFactor';

type User = JwtPayload;
const intervalMin = 30;

interface AuthCredentials {
  username: string;
  password: string;
  /** The 2FA code (or a recovery code) - only for users with 2FA. */
  otp?: string;
}

/** How a login ended: an OtpReason asks the form for the 2FA code. */
export type LoginOutcome = 'ok' | 'failed' | OtpReason;

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
  user: User | null;
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
  try {
    const response = await axios.post(
      `${API_URL}/api/token/refresh/`,
      refreshToken,
      {
        headers: { Authorization: `Bearer ${refreshToken}` },
      },
    );

    return {
      isSuccess: true,
      newAuthToken: response.data.token,
      newAuthTokenExpireIn: intervalMin,
      newRefreshTokenExpiresIn: intervalMin * 2,
    } as AuthRefresh;
  } catch (error) {
    console.error(error);
    return {
      isSuccess: false,
    } as AuthRefresh;
  }
};

const defaultAuthContextValue: AuthContextType = {
  token: '',
  refreshToken: '',
  user: null,
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

const API_URL = getBackendBaseUrl();

const CoreAuthProvider = ({ children }) => {
  const [token, setToken] = useState(localStorage.getItem('authToken') || '');
  const [refreshToken, setRefreshToken] = useState(
    localStorage.getItem('refreshToken') || '',
  );
  const [user, setUser] = useState<User | null>(null);
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

  // useEffect(() => {
  //   if (user) {
  //     console.log('USER', user);
  //   }
  // }, [user]);

  const getCurrentUrl = () => {
    return location.pathname;
  };

  const logoutAction = useCallback(
    async (forward?: string) => {
      try {
        await axios.post(`${API_URL}/api/token/logout/`, {
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
        localStorage.removeItem('authToken');
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
    [navigate, user],
  );

  const loginAction = useCallback(
    async (data: AuthCredentials, forward?: string): Promise<LoginOutcome> => {
      try {
        const response = await axios.post(`${API_URL}/api/token/`, data);
        const newToken = response.data.access;
        localStorage.setItem('authToken', newToken);
        setToken(newToken);
        setRefreshToken(response.data.refresh);

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
    [navigate, logoutAction], // depends on logoutAction as it is defined below
  );

  const loginWithTokens = useCallback((access: string, refresh: string) => {
    localStorage.setItem('authToken', access);
    setToken(access);
    setRefreshToken(refresh);
  }, []);

  // One object per real change (token, user, path): views load their data in
  // effects that depend on `auth` - a new object on every render of the
  // provider made them request it again.
  const pathname = location.pathname;
  const value = useMemo(
    () => ({
      token,
      refreshToken,
      user,
      refreshApi: () => refreshApi(refreshToken),
      loginAction,
      loginWithTokens,
      logoutAction,
      navigate: (to, options) => navigate(to, options),
      location: pathname,
    }),
    [token, user, refreshToken, loginAction, loginWithTokens, logoutAction, navigate, pathname],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export default CoreAuthProvider;

export const useAuth = (): AuthContextType => {
  return useContext(AuthContext);
};
