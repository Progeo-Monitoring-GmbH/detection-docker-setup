// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosResponse } from 'axios';
import axiosConfig from './axiosConfig';
import type { AuthContextType } from '../hooks/CoreAuthProvider';

const makeAuth = (location = '/location/5/status') =>
  ({ navigate: vi.fn(), location }) as unknown as AuthContextType & {
    navigate: ReturnType<typeof vi.fn>;
  };

const okResponse = (data: unknown) => ({ data, status: 200 }) as AxiosResponse;
const httpError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { reason: 'nope' } },
  });

beforeEach(() => {
  localStorage.clear();
  delete axiosConfig.holder.defaults.headers.common['Authorization'];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('axiosConfig.holder', () => {
  it('is a singleton axios instance', () => {
    expect(axiosConfig.holder).toBe(axiosConfig.holder);
    expect(axiosConfig.getInstance).toBe(axiosConfig.getInstance);
  });
});

describe('perform_get', () => {
  it('calls the success callback with the response', async () => {
    const response = okResponse({ id: 1 });
    const get = vi.spyOn(axiosConfig.holder, 'get').mockResolvedValue(response);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const auth = makeAuth();

    await axiosConfig.perform_get(auth, '/v1/thing/', onSuccess, onError, { params: { a: 1 } });

    expect(get).toHaveBeenCalledWith('/v1/thing/', { params: { a: 1 } });
    expect(onSuccess).toHaveBeenCalledWith(response);
    expect(onError).not.toHaveBeenCalled();
    expect(auth.navigate).not.toHaveBeenCalled();
  });

  it('calls the error callback on rejection without redirecting for non-auth errors', async () => {
    const error = httpError(500);
    vi.spyOn(axiosConfig.holder, 'get').mockRejectedValue(error);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const auth = makeAuth();

    await axiosConfig.perform_get(auth, '/v1/thing/', onSuccess, onError);

    expect(onError).toHaveBeenCalledWith(error);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(auth.navigate).not.toHaveBeenCalled();
  });

  it.each([401, 403])('redirects to the login page with a forward on %i', async (status) => {
    vi.spyOn(axiosConfig.holder, 'get').mockRejectedValue(httpError(status));
    const onError = vi.fn();
    const auth = makeAuth('/location/5/status');

    await axiosConfig.perform_get(auth, '/v1/thing/', vi.fn(), onError);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(auth.navigate).toHaveBeenCalledWith('/login?forward=/location/5/status');
  });

  it('does not throw on 401 when no auth context is given', async () => {
    vi.spyOn(axiosConfig.holder, 'get').mockRejectedValue(httpError(401));
    const onError = vi.fn();

    await expect(
      axiosConfig.perform_get(undefined as unknown as AuthContextType, '/x', vi.fn(), onError),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('handles errors without a response (network errors)', async () => {
    const error = new Error('Network Error');
    vi.spyOn(axiosConfig.holder, 'get').mockRejectedValue(error);
    const onError = vi.fn();
    const auth = makeAuth();

    await axiosConfig.perform_get(auth, '/x', vi.fn(), onError);

    expect(onError).toHaveBeenCalledWith(error);
    expect(auth.navigate).not.toHaveBeenCalled();
  });

  it('uses the default error callback (console.error) when none is given', async () => {
    vi.spyOn(axiosConfig.holder, 'get').mockRejectedValue(httpError(500));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await axiosConfig.perform_get(makeAuth(), '/x', vi.fn());

    expect(consoleError).toHaveBeenCalledWith({ reason: 'nope' });
  });

  it('returns the success callback result', async () => {
    vi.spyOn(axiosConfig.holder, 'get').mockResolvedValue(okResponse('ok'));
    await expect(
      axiosConfig.perform_get(makeAuth(), '/x', (response) => response.data),
    ).resolves.toBe('ok');
  });

  it('sets a Bearer header from localStorage authToken', async () => {
    localStorage.setItem('authToken', 'jwt-abc');
    vi.spyOn(axiosConfig.holder, 'get').mockResolvedValue(okResponse(null));

    await axiosConfig.perform_get(makeAuth(), '/x', vi.fn());

    expect(axiosConfig.holder.defaults.headers.common['Authorization']).toBe('Bearer jwt-abc');
  });

  it('leaves the Authorization header untouched when there is no token', async () => {
    vi.spyOn(axiosConfig.holder, 'get').mockResolvedValue(okResponse(null));

    await axiosConfig.perform_get(makeAuth(), '/x', vi.fn());

    expect(axiosConfig.holder.defaults.headers.common['Authorization']).toBeUndefined();
  });
});

describe('perform_post', () => {
  it('posts the data and config and calls the success callback', async () => {
    const response = okResponse({ created: true });
    const post = vi.spyOn(axiosConfig.holder, 'post').mockResolvedValue(response);
    const onSuccess = vi.fn();
    const config = { headers: { 'X-Test': '1' } };

    await axiosConfig.perform_post(makeAuth(), '/v1/thing/', { name: 'a' }, onSuccess, vi.fn(), config);

    expect(post).toHaveBeenCalledWith('/v1/thing/', { name: 'a' }, config);
    expect(onSuccess).toHaveBeenCalledWith(response);
  });

  it('calls the error callback and redirects on 401', async () => {
    const error = httpError(401);
    vi.spyOn(axiosConfig.holder, 'post').mockRejectedValue(error);
    const onError = vi.fn();
    const auth = makeAuth('/settings');

    await axiosConfig.perform_post(auth, '/v1/thing/', {}, vi.fn(), onError);

    expect(onError).toHaveBeenCalledWith(error);
    expect(auth.navigate).toHaveBeenCalledWith('/login?forward=/settings');
  });

  it('does not redirect on 400', async () => {
    vi.spyOn(axiosConfig.holder, 'post').mockRejectedValue(httpError(400));
    const auth = makeAuth();

    await axiosConfig.perform_post(auth, '/v1/thing/', {}, vi.fn(), vi.fn());

    expect(auth.navigate).not.toHaveBeenCalled();
  });

  it('uses an explicit config.token as a "Token" Authorization header', async () => {
    localStorage.setItem('authToken', 'jwt-abc');
    vi.spyOn(axiosConfig.holder, 'post').mockResolvedValue(okResponse(null));

    await axiosConfig.perform_post(makeAuth(), '/x', {}, vi.fn(), vi.fn(), { token: 'api-key' });

    expect(axiosConfig.holder.defaults.headers.common['Authorization']).toBe('Token api-key');
  });
});

describe('perform_patch', () => {
  it('patches the data and calls the success callback', async () => {
    const response = okResponse({ updated: true });
    const patch = vi.spyOn(axiosConfig.holder, 'patch').mockResolvedValue(response);
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await axiosConfig.perform_patch(makeAuth(), '/v1/thing/1/', { name: 'b' }, onSuccess, onError);

    expect(patch).toHaveBeenCalledWith('/v1/thing/1/', { name: 'b' }, {});
    expect(onSuccess).toHaveBeenCalledWith(response);
    expect(onError).not.toHaveBeenCalled();
  });

  it('calls the error callback and redirects on 403', async () => {
    vi.spyOn(axiosConfig.holder, 'patch').mockRejectedValue(httpError(403));
    const onError = vi.fn();
    const auth = makeAuth('/a');

    await axiosConfig.perform_patch(auth, '/v1/thing/1/', {}, vi.fn(), onError);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(auth.navigate).toHaveBeenCalledWith('/login?forward=/a');
  });
});
