import axios, {
  AxiosInstance,
  AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import Cookies from 'js-cookie';
import { enqueueSnackbar } from 'notistack';
import { AuthContextType } from '../hooks/CoreAuthProvider';
import { getBackendBaseUrl } from './backendUrl';
import {
  permissionDeniedMessage,
  withoutErrorToasts,
} from './components/ui/Snackbar.jsx';
import i18n from './i18n.jsx';
import { isDemoReadOnlyError, isDemoUser, loginPathFor } from './main/demo';
import { isImpersonationBlockedError } from './main/impersonation';
import { isTwoFactorSetupError, TWO_FACTOR_SETUP_PATH } from './main/twoFactor';
import {
  isPendingReviewError,
  PENDING_REVIEW_PATH,
} from './main/pendingReview';
import { watchAxios } from './maintenance';
import { refreshAccessToken } from './tokenRefresh';
import {
  notePermissionsVersion,
  PERMISSIONS_HEADER,
} from './permissionVersion';

// The login/logout requests (CoreAuthProvider) use the global instance.
watchAxios(axios);

export const defaultErrorCallback = (error) => {
  if (error.response) {
    console.error(error.response.data);
  } else {
    console.error(error);
  }
};

const normalizeBackendUrl = (rawUrl?: string) => {
  if (!rawUrl) {
    return rawUrl;
  }
  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    return rawUrl.replace(/^http:\/\//i, 'https://');
  }
  return rawUrl;
};

/** notistack key of the "no permission" toast - one at a time (testable via data-test-key). */
export const PERMISSION_DENIED_TOAST_KEY = 'permission-denied';

/**
 * A 403 for a missing right - not one of the special 403s (2FA setup,
 * pending review, read-only demo, impersonation) and not for a demo user
 * (a page the demo doesn't offer: their handling stays the caller's).
 */
const isRefused = (error, auth: AuthContextType | undefined) =>
  error?.response?.status === 403 &&
  !isDemoReadOnlyError(error) &&
  !isImpersonationBlockedError(error) &&
  !isTwoFactorSetupError(error) &&
  !isPendingReviewError(error) &&
  !isDemoUser(auth?.user);

export interface IConfig {
  token?: string;
  headers?: object;
  onUploadProgress?: (_) => void;
}

export default class axiosConfig {
  static instance;
  axiosHolder: AxiosInstance;

  constructor() {
    this.axiosHolder = axios.create({
      baseURL: normalizeBackendUrl(getBackendBaseUrl()),
    });
    watchAxios(this.axiosHolder);

    // An expired access token is renewed and the request retried once. This
    // covers tabs asleep past the token lifetime; CoreAuthProvider also
    // renews proactively. Only Bearer sessions refresh - an explicit "Token"
    // (transfer token) must never be replaced by the user's session.
    type RetryableConfig = InternalAxiosRequestConfig & {
      __authRetry?: boolean;
    };
    this.axiosHolder.interceptors.response.use(
      (response) => {
        // Permissions changed since the last answer: fetched again (permissionVersion.ts).
        notePermissionsVersion(response?.headers?.[PERMISSIONS_HEADER]);
        return response;
      },
      async (error) => {
        // A 403 may be the change itself (a permission taken away).
        notePermissionsVersion(error?.response?.headers?.[PERMISSIONS_HEADER]);
        const config = error?.config as RetryableConfig | undefined;
        const authorization = config?.headers?.Authorization;
        const isBearer =
          typeof authorization === 'string' &&
          authorization.startsWith('Bearer ');
        if (
          error?.response?.status !== 401 ||
          !config ||
          !isBearer ||
          config.__authRetry ||
          String(config.url || '').includes('/api/token/')
        ) {
          return Promise.reject(error);
        }
        config.__authRetry = true;
        const access = await refreshAccessToken();
        if (!access) {
          return Promise.reject(error);
        }
        if (typeof config.headers.set === 'function') {
          config.headers.set('Authorization', `Bearer ${access}`);
        } else {
          config.headers.Authorization = `Bearer ${access}`;
        }
        return this.axiosHolder.request(config);
      },
    );

    const csrftoken = Cookies.get('csrftoken');

    if (csrftoken) {
      this.axiosHolder.defaults.headers.common['X-CSRFToken'] =
        `csrftoken ${csrftoken}`;
    }
  }

  static get getInstance() {
    if (axiosConfig.instance == null) {
      axiosConfig.instance = new axiosConfig();
    }
    return this.instance;
  }

  static get holder() {
    return axiosConfig.getInstance.axiosHolder;
  }

  /**
   * Runs a request; on 401 the user is sent to the login page (demo users:
   * their demo link). A 403 means "logged in, but not allowed": the user
   * stays on the page and gets one error toast (permissionDeniedMessage) -
   * the caller's error callback still runs, its own error toasts are left
   * out (withoutErrorToasts), and the fixed key collapses the 403s of
   * parallel requests into that one toast. Special 403s: 2FA still to set
   * up goes to that setup, an account waiting for review to the "being
   * reviewed" panel, a write refused by the read-only demo or while
   * impersonating runs the caller's error handling (errorReason() explains
   * it; callers without one get a hint here), and demo users keep just the
   * caller's handling.
   */
  private static async handle(
    auth: AuthContextType | undefined,
    request: Promise<AxiosResponse>,
    callBackSuccess,
    callBackError = defaultErrorCallback,
  ) {
    return await request.then(
      (response) => callBackSuccess(response),
      (error) => {
        if (isRefused(error, auth)) {
          enqueueSnackbar(permissionDeniedMessage(error), {
            variant: 'error',
            key: PERMISSION_DENIED_TOAST_KEY,
            preventDuplicate: true,
          });
          withoutErrorToasts(() => callBackError(error));
          return;
        }
        callBackError(error);
        if (isDemoReadOnlyError(error)) {
          if (callBackError === defaultErrorCallback) {
            enqueueSnackbar(i18n.t('demo_read_only'), { variant: 'info' });
          }
          return;
        }
        if (isImpersonationBlockedError(error)) {
          // Logged in as another user: their credentials stay theirs.
          if (callBackError === defaultErrorCallback) {
            enqueueSnackbar(i18n.t('impersonation_blocked'), {
              variant: 'info',
            });
          }
          return;
        }
        if (isTwoFactorSetupError(error)) {
          // Logged in fine, but nothing is reachable before 2FA is set up.
          auth?.navigate(TWO_FACTOR_SETUP_PATH);
          return;
        }
        if (isPendingReviewError(error)) {
          // Logged in fine, but the account still waits for the staff's
          // review: the "being reviewed" panel - sending the user to the
          // login page would only loop back here.
          if (auth?.location !== PENDING_REVIEW_PATH) {
            auth?.navigate(PENDING_REVIEW_PATH);
          }
          return;
        }
        // Only an expired/missing login sends the user to the login page (demo
        // users: their link) - a 403 is a missing right, logging in again
        // wouldn't change it (see isRefused above).
        if (error?.response?.status === 401 && auth) {
          auth.navigate(loginPathFor(auth.user, auth.location));
        }
      },
    );
  }

  static async perform_post(
    auth: AuthContextType | undefined,
    url: string,
    data,
    callBackSuccess,
    callBackError = defaultErrorCallback,
    config: IConfig = {},
  ) {
    axiosConfig.updateToken(config.token);
    return axiosConfig.handle(
      auth,
      axiosConfig.holder.post(url, data, config),
      callBackSuccess,
      callBackError,
    );
  }

  static async perform_patch(
    auth: AuthContextType | undefined,
    url: string,
    data,
    callBackSuccess,
    callBackError = defaultErrorCallback,
    config: IConfig = {},
  ) {
    axiosConfig.updateToken(config.token);
    return axiosConfig.handle(
      auth,
      axiosConfig.holder.patch(url, data, config),
      callBackSuccess,
      callBackError,
    );
  }

  static async perform_get(
    auth: AuthContextType,
    url,
    callBackSuccess,
    callBackError = defaultErrorCallback,
    config = {},
  ) {
    axiosConfig.updateToken();
    return axiosConfig.handle(
      auth,
      axiosConfig.holder.get(url, config),
      callBackSuccess,
      callBackError,
    );
  }

  static updateToken(token = '') {
    if (token.length) {
      axiosConfig.holder.defaults.headers.common['Authorization'] =
        `Token ${token}`;
    } else {
      const authToken = localStorage.getItem('authToken');
      if (authToken) {
        axiosConfig.holder.defaults.headers.common['Authorization'] =
          `Bearer ${authToken}`;
      }
    }
    return axiosConfig.holder;
  }
}
