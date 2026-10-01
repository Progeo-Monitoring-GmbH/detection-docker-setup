// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  capitalizeFirstLetter,
  dateStringToTimestamp,
  defaultErrorCallback,
  filterObject,
  getBasename,
  getCachedData,
  getDeepKeyFromObject,
  prettyDate,
  removeElementFromArray,
  setCachedDataWithDispatcher,
  updateOrAppend,
  updateOrPrepend,
} from './helper.jsx';

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('updateOrAppend / updateOrPrepend', () => {
  it('appends a new element', () => {
    const list = [{ id: 1 }];
    expect(updateOrAppend(list, { id: 2 })).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('prepends a new element', () => {
    const list = [{ id: 1 }];
    expect(updateOrPrepend(list, { id: 2 })).toEqual([{ id: 2 }, { id: 1 }]);
  });

  it('replaces an existing element in place (same position)', () => {
    const list = [{ id: 1, v: 'a' }, { id: 2, v: 'b' }];
    expect(updateOrAppend(list, { id: 1, v: 'x' })).toEqual([{ id: 1, v: 'x' }, { id: 2, v: 'b' }]);
    expect(updateOrPrepend(list, { id: 2, v: 'y' })).toEqual([{ id: 1, v: 'x' }, { id: 2, v: 'y' }]);
  });

  it('matches on a custom field', () => {
    const list = [{ mac: 'aa', v: 1 }];
    expect(updateOrAppend(list, { mac: 'aa', v: 2 }, 'mac')).toEqual([{ mac: 'aa', v: 2 }]);
  });

  it('mutates and returns the same array', () => {
    const list = [{ id: 1 }];
    expect(updateOrAppend(list, { id: 2 })).toBe(list);
  });

  it('returns undefined for an undefined list', () => {
    expect(updateOrAppend(undefined, { id: 1 })).toBeUndefined();
    expect(updateOrPrepend(undefined, { id: 1 })).toBeUndefined();
  });
});

describe('removeElementFromArray / filterObject', () => {
  it('removes by identity without mutating', () => {
    const a = { id: 1 };
    const b = { id: 2 };
    const list = [a, b];
    expect(removeElementFromArray(list, a)).toEqual([b]);
    expect(list).toHaveLength(2);
  });

  it('does not remove structurally equal but different objects', () => {
    const list = [{ id: 1 }];
    expect(removeElementFromArray(list, { id: 1 })).toHaveLength(1);
  });

  it('filterObject keeps matching entries', () => {
    expect(filterObject({ a: 1, b: 2, c: 3 }, ([, value]) => value > 1)).toEqual({ b: 2, c: 3 });
  });
});

describe('string helpers', () => {
  it('capitalizeFirstLetter', () => {
    expect(capitalizeFirstLetter('hello')).toBe('Hello');
    expect(capitalizeFirstLetter('Hello')).toBe('Hello');
    expect(capitalizeFirstLetter('')).toBe('');
  });

  it('getBasename handles both slash styles', () => {
    expect(getBasename('/media/files/a.pdf')).toBe('a.pdf');
    expect(getBasename('C:\\docs\\b.txt')).toBe('b.txt');
    expect(getBasename('plain.txt')).toBe('plain.txt');
  });
});

describe('prettyDate', () => {
  it('returns "-" for empty values', () => {
    expect(prettyDate(null)).toBe('-');
    expect(prettyDate(undefined)).toBe('-');
    expect(prettyDate('')).toBe('-');
  });

  it('returns unparseable values unchanged', () => {
    expect(prettyDate('garbage')).toBe('garbage');
  });

  it('formats valid dates in de-DE with 24h clock', () => {
    const value = '2026-08-19T11:08:09Z';
    const expected = new Date(value).toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    expect(prettyDate(value)).toBe(expected);
    expect(prettyDate(value)).toMatch(/^\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}:\d{2}$/);
  });
});

describe('dateStringToTimestamp', () => {
  it('returns epoch ms, minus an optional offset', () => {
    const iso = '2026-01-01T00:00:00Z';
    expect(dateStringToTimestamp(iso)).toBe(Date.UTC(2026, 0, 1));
    expect(dateStringToTimestamp(iso, 1000)).toBe(Date.UTC(2026, 0, 1) - 1000);
  });
});

describe('getDeepKeyFromObject', () => {
  const data = { a: 1, location: { project: { name: 'P1' } } };

  it('reads a flat key', () => {
    expect(getDeepKeyFromObject(data, 'a')).toBe(1);
  });

  it('follows "__"-separated paths', () => {
    expect(getDeepKeyFromObject(data, 'location__project__name')).toBe('P1');
  });

  it('returns undefined for missing intermediate keys', () => {
    expect(getDeepKeyFromObject(data, 'missing__project__name')).toBeUndefined();
    expect(getDeepKeyFromObject(data, 'location__missing__name')).toBeUndefined();
  });
});

describe('session cache helpers', () => {
  it('getCachedData returns the default when nothing is cached', () => {
    expect(getCachedData('nope')).toEqual([]);
    expect(getCachedData('nope', { x: 1 })).toEqual({ x: 1 });
  });

  it('setCachedDataWithDispatcher stores and dispatches objects and booleans', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dispatch = vi.fn();
    setCachedDataWithDispatcher('k', dispatch, 'SET', { a: 1 });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET', payload: { a: 1 } });
    expect(getCachedData('k')).toEqual({ a: 1 });

    setCachedDataWithDispatcher('b', dispatch, 'SET_B', false);
    expect(getCachedData('b', true)).toBe(false);
  });

  it('setCachedDataWithDispatcher ignores empty objects and other types', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dispatch = vi.fn();
    setCachedDataWithDispatcher('e', dispatch, 'SET', {});
    setCachedDataWithDispatcher('s', dispatch, 'SET', 'string');
    expect(dispatch).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('e')).toBeNull();
  });
});

describe('defaultErrorCallback', () => {
  it('logs response.data when present, else the error', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    defaultErrorCallback({ response: { data: { reason: 'x' } } });
    expect(consoleError).toHaveBeenLastCalledWith({ reason: 'x' });
    const error = new Error('net');
    defaultErrorCallback(error);
    expect(consoleError).toHaveBeenLastCalledWith(error);
  });
});
