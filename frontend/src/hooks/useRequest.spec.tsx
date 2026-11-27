// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestError, RequestState } from './useRequest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Pending = { url: string; ok: (response: unknown) => void; fail: (error: unknown) => void };

// Requests stay open until a test answers them - in any order.
const api = vi.hoisted(() => ({ pending: [] as Pending[] }));

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: Pending['ok'], fail: Pending['fail']) => {
      api.pending.push({ url, ok, fail });
    },
  },
}));

const { useRequest } = await import('./useRequest');

let container: HTMLDivElement;
let root: Root;
let state: RequestState<string>;

type ProbeProps = {
  url: string | null;
  onError?: (error: RequestError) => void;
  onSuccess?: (data: string) => void;
  revision?: number;
};

const Probe = ({ url, onError, onSuccess, revision }: ProbeProps) => {
  const result = useRequest<string>(url, {
    auth: {} as never,
    transform: (body) => body?.value,
    onError,
    onSuccess,
    revision,
  });
  // Handed out after every render (act() flushes it before the checks).
  useLayoutEffect(() => {
    state = result;
  });
  return null;
};

const render = (props: ProbeProps) => act(() => root.render(<Probe {...props} />));
const answer = (index: number, value: string) => act(() => api.pending[index].ok({ data: { value } }));

beforeEach(() => {
  api.pending.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useRequest', () => {
  it('loads the URL: loading until the answer, then its data', () => {
    const onSuccess = vi.fn();
    render({ url: '/a/', onSuccess });
    expect(state.loading).toBe(true);
    expect(state.data).toBeNull();
    expect(api.pending.map((request) => request.url)).toEqual(['/a/']);
    answer(0, 'A');
    expect(state).toMatchObject({ loading: false, data: 'A', error: null });
    expect(onSuccess).toHaveBeenCalledWith('A');
  });

  it('a new URL shows loading at once and drops the late answer of the previous one', () => {
    render({ url: '/a/' });
    answer(0, 'A');
    render({ url: '/b/' });
    expect(state.loading).toBe(true);
    // The previous answer stays visible while the new one loads.
    expect(state.data).toBe('A');
    render({ url: '/c/' });
    expect(api.pending.map((request) => request.url)).toEqual(['/a/', '/b/', '/c/']);
    answer(1, 'B');
    expect(state).toMatchObject({ loading: true, data: 'A' });
    answer(2, 'C');
    expect(state).toMatchObject({ loading: false, data: 'C' });
  });

  it('reload reads the same URL again (or a variant of it) and resolves with the data', async () => {
    render({ url: '/a/' });
    answer(0, 'A');
    let reloaded: Promise<string | undefined> | undefined;
    act(() => {
      reloaded = state.reload();
    });
    expect(state.loading).toBe(true);
    expect(api.pending[1].url).toBe('/a/');
    answer(1, 'A2');
    expect(state).toMatchObject({ loading: false, data: 'A2' });
    await expect(reloaded).resolves.toBe('A2');

    act(() => {
      void state.reload('/a/?refresh=true');
    });
    expect(api.pending[2].url).toBe('/a/?refresh=true');
    answer(2, 'A3');
    expect(state.data).toBe('A3');
  });

  it('a revision reads the same URL again; new callbacks do not', () => {
    render({ url: '/a/', revision: 0, onError: () => undefined });
    answer(0, 'A');
    render({ url: '/a/', revision: 0, onError: () => undefined });
    expect(api.pending).toHaveLength(1);
    render({ url: '/a/', revision: 1 });
    expect(state.loading).toBe(true);
    expect(api.pending.map((request) => request.url)).toEqual(['/a/', '/a/']);
  });

  it('a null URL fetches nothing and drops the data', async () => {
    render({ url: null });
    expect(state).toMatchObject({ loading: false, data: null });
    expect(api.pending).toHaveLength(0);
    await expect(state.reload()).resolves.toBeUndefined();
    expect(api.pending).toHaveLength(0);

    render({ url: '/a/' });
    answer(0, 'A');
    render({ url: '/b/' });
    render({ url: null });
    expect(state).toMatchObject({ loading: false, data: null });
    answer(1, 'B');
    expect(state.data).toBeNull();
  });

  it('an error ends loading, keeps the data and reaches onError - a stale one does not', () => {
    const onError = vi.fn();
    render({ url: '/a/', onError });
    answer(0, 'A');
    act(() => {
      void state.reload();
    });
    const failure = { response: { status: 500 } };
    act(() => api.pending[1].fail(failure));
    expect(state).toMatchObject({ loading: false, data: 'A', error: failure });
    expect(onError).toHaveBeenCalledWith(failure);

    render({ url: '/b/', onError });
    expect(state.error).toBeNull();
    render({ url: '/c/', onError });
    act(() => api.pending[2].fail(failure));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(state.loading).toBe(true);
  });
});
