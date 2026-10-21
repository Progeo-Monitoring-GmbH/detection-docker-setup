import axios, { AxiosInstance, AxiosResponse } from 'axios';
import Cookies from 'js-cookie';
import { enqueueSnackbar } from 'notistack';
import { AuthContextType } from '../hooks/CoreAuthProvider';
import { getBackendBaseUrl } from './backendUrl';
import { defaultErrorCallback } from './helper.jsx';
import i18n from './i18n.jsx';
import { isDemoReadOnlyError, isDemoUser, loginPathFor } from './main/demo';

const normalizeBackendUrl = (rawUrl?: string) => {
  if (!rawUrl) return rawUrl;
  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    return rawUrl.replace(/^http:\/\//i, 'https://');
  }
  return rawUrl;
};

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
   * Runs a request; on 401/403 the user is sent to the login page (demo
   * users: their demo link). A write refused because of the read-only demo
   * is no auth problem - the caller's error handling runs (errorReason()
   * explains it), callers without one get a hint here.
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
        callBackError(error);
        if (isDemoReadOnlyError(error)) {
          if (callBackError === defaultErrorCallback) {
            enqueueSnackbar(i18n.t('demo_read_only'), { variant: 'info' });
          }
          return;
        }
        // Demo users only log in again (via their link) on an expired session -
        // a 403 is a page the demo doesn't offer, and the link wouldn't help.
        const status = error?.response?.status;
        const relogin = status === 401 || (status === 403 && !isDemoUser(auth?.user));
        if (relogin && auth) {
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
    return axiosConfig.handle(auth, axiosConfig.holder.post(url, data, config), callBackSuccess, callBackError);
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
    return axiosConfig.handle(auth, axiosConfig.holder.patch(url, data, config), callBackSuccess, callBackError);
  }

  static async perform_get(
    auth: AuthContextType,
    url,
    callBackSuccess,
    callBackError = defaultErrorCallback,
    config = {},
  ) {
    axiosConfig.updateToken();
    return axiosConfig.handle(auth, axiosConfig.holder.get(url, config), callBackSuccess, callBackError);
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
