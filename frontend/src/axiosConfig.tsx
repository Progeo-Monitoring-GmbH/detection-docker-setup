import axios, { AxiosInstance, AxiosResponse } from 'axios';
import Cookies from 'js-cookie';
import { AuthContextType } from '../hooks/CoreAuthProvider';
import { defaultErrorCallback } from './helper.jsx';

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
      baseURL: normalizeBackendUrl(import.meta.env.VITE_BACKEND_URL),
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

  /** Runs a request; on 401/403 the user is sent to the login page. */
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
        if ([401, 403].includes(error?.response?.status) && auth) {
          auth.navigate(`/login?forward=${auth.location}`);
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
