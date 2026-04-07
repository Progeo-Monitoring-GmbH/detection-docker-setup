import axios, { AxiosInstance } from 'axios';
import Cookies from 'js-cookie';
import { AuthContextType } from '../hooks/CoreAuthProvider';
import { defaultErrorCallback } from './helper.jsx';

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
      baseURL: import.meta.env.VITE_BACKEND_URL,
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

  static async perform_post(
    auth: AuthContextType | undefined,
    url: string,
    data,
    callBackSuccess,
    callBackError = defaultErrorCallback,
    config: IConfig = {},
  ) {
    axiosConfig.updateToken(config.token);
    await axiosConfig.holder.post(url, data, config).then(
      (response) => {
        callBackSuccess(response);
      },
      (error) => {
        if (error.response.status === 401) {
          if (auth?.token) {
            auth.navigate(`/login?forward=${auth.location}`);
            return;
          }
        }
        callBackError(error);
      },
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
    return await axiosConfig.holder.get(url, config).then(
      (response) => callBackSuccess(response),
      (error) => {
        if (error?.response?.status === 401) {
          if (auth?.token) {
            auth.navigate(`/login?forward=${auth.location}`);
            return;
          }
        }
        callBackError(error);
      },
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
