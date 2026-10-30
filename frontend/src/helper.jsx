import axiosConfig, { defaultErrorCallback } from './axiosConfig';
import { downloadBlob } from './download';

export const prettyDate = (value) => {
  if (!value) {
    return '-';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
};

export const dateStringToTimestamp = (dateString, offset = 0) => {
  const date = new Date(dateString);
  if (offset) {
    return date.getTime() - offset;
  }
  return date.getTime();
};

export function updateOrAppend(elements, newData, field = 'id') {
  if (elements !== undefined) {
    let index = elements.findIndex(
      (element) => element[field] === newData[field],
    );
    if (index === -1) {
      elements.push(newData);
      return elements;
    } else {
      elements[index] = newData;
    }
  }
  return elements;
}

export function updateOrPrepend(elements, newData, field = 'id') {
  if (elements !== undefined) {
    let index = elements.findIndex(
      (element) => element[field] === newData[field],
    );
    if (index === -1) {
      elements.unshift(newData);
      return elements;
    } else {
      elements[index] = newData;
    }
  }
  return elements;
}

export function removeElementFromArray(elements, newData) {
  return elements.filter((item) => item !== newData);
}

export function filterObject(elements, filter) {
  return Object.fromEntries(Object.entries(elements).filter(filter));
}

export function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

export function getBasename(_path) {
  return _path.split(/[\\/]/).pop();
}

export async function standardFetchData(
  auth,
  url,
  setter,
  header = {},
  callBackError = defaultErrorCallback,
) {
  return await axiosConfig.perform_get(
    auth,
    url,
    (response) => {
      setter(response.data);
    },
    callBackError,
    header,
  );
}

export async function openResponseInNewTab(auth, url) {
  await axiosConfig.perform_get(
    auth,
    url,
    (response) => {
      const blob = new Blob([response.data], {
        type: response.headers['content-type'],
      });
      const url = window.URL.createObjectURL(blob);
      window.open(url, '_blank');
    },
    defaultErrorCallback,
    {
      responseType: 'blob',
    },
  );
}

/** Downloads a GET response as a file named `filename` (instead of
 * opening it, which shows e.g. a PDF in the browser's viewer). Resolves
 * with whether it worked. */
export async function downloadResponse(auth, url, filename) {
  let ok = false;
  await axiosConfig.perform_get(
    auth,
    url,
    (response) => {
      const blob = new Blob([response.data], {
        type: response.headers['content-type'],
      });
      downloadBlob(blob, filename);
      ok = true;
    },
    defaultErrorCallback,
    {
      responseType: 'blob',
    },
  );
  return ok;
}

export const getCachedData = (_key, _default = []) => {
  let raw = sessionStorage.getItem(_key);
  return raw ? JSON.parse(raw) : _default;
};

export const setCachedDataWithDispatcher = (
  _key,
  _dispatch,
  _type,
  payload,
) => {
  if (
    (typeof payload == 'object' && Object.keys(payload).length) ||
    typeof payload == 'boolean'
  ) {
    sessionStorage.setItem(_key, JSON.stringify(payload));
    _dispatch({ type: _type, payload: payload });
    console.log(`Set Cached-Data(Dispatcher): ${_key}=${payload}`);
  } else {
    console.log('Unhandled Type', typeof payload, _key);
  }
};

export function getDeepKeyFromObject(data, _field) {
  if (_field.includes('__')) {
    let fields = _field.split('__');
    let result = data;
    for (let field of fields) {
      result = result[field];
      if (result === undefined) {
        break;
      }
    }
    return result;
  } else {
    return data[_field];
  }
}
