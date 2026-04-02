import React, { useState } from 'react';
import { Link } from '@mui/material';
import axiosConfig from './axiosConfig';
import { Button } from 'react-bootstrap';

export function generateRandomNumber(min = 0, max = 1, fixxed = 0) {
  const v = Math.random() * (max - min) + min;
  if (fixxed) {
    return Number(v.toFixed(fixxed));
  }
  return v;
}

export function generateRandomFrom(arr) {
  return arr[(Math.random() * arr.length) >> 0];
}

export const prettyBool = (value) => {
  if (value) {
    return <span className={'text-success'}>True</span>;
  } else {
    return <span className={'text-danger'}>False</span>;
  }
};

export const getToday = () => {
  return new Date().toLocaleDateString('fr-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
};

export const dateStringToTimestamp = (dateString, offset = 0) => {
  const date = new Date(dateString);
  if (offset) {
    return date.getTime() - offset;
  }
  return date.getTime();
};

export function SelectListened({
  options,
  onChange,
  disabled,
  selected = undefined,
}) {
  return (
    <select
      className={'form-select mb-3'}
      disabled={disabled || null}
      onChange={onChange}
    >
      {Object.keys(options).map((value) => {
        if (options[value] === selected) {
          return (
            <option
              data-key={value === selected}
              key={value}
              value={value}
              selected={true}
            >
              {options[value]}
            </option>
          );
        } else {
          return (
            <option data-key={value === selected} key={value} value={value}>
              {options[value]}
            </option>
          );
        }
      })}
    </select>
  );
}

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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

export function getBasename(_path) {
  return _path.split(/[\\/]/).pop();
}


export const defaultErrorCallback = (error) => {
  if (error.response) {
    console.error(error.response.data);
  } else {
    console.error(error);
  }
};

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

export async function openPostResponseInNewTab(url, data, auth) {
  await axiosConfig.perform_post(
    auth,
    url,
    data,
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
