// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { type AxiosResponse } from 'axios';
import type { AuthContextType } from '../hooks/CoreAuthProvider';

// The toasts axiosConfig shows itself (notistack's global enqueueSnackbar).
const { enqueueSnackbar } = vi.hoisted(() => ({ enqueueSnackbar: vi.fn() }));
vi.mock('notistack', () => ({ enqueueSnackbar }));

const { default: axiosConfig, PERMISSION_DENIED_TOAST_KEY } = await import('./axiosConfig');
const { showRequestError } = await import('./components/ui/Snackbar.jsx');
const { default: i18n } = await import('./i18n.jsx');

const makeAuth = (location = '/location/5/status', user: unknown = {}) =>
  ({ navigate: vi.fn(), location, user }) as unknown as AuthContextType & {
    navigate: ReturnType<typeof vi.fn>;
  };

const okResponse = (data: unknown) => ({ data, status: 200 }) as AxiosResponse;
const httpError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { reason: 'nope' } },
  });

beforeEach(() => {
  enqueueSnackbar.mockReset();
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

  it('redirects to the login page with a forward on 401', async () => {
    vi.spyOn(axiosConfig.holder, 'get').mockRejectedValue(httpError(401));
    const onError = vi.fn();
    const auth = makeAuth('/location/5/status');

    await axiosConfig.perform_get(auth, '/v1/thing/', vi.fn(), onError);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(auth.navigate).toHaveBeenCalledWith('/login?forward=/location/5/status');
    expect(enqueueSnackbar).not.toHaveBeenCalled();
  });

  it('sends a user who has to set up 2FA to that setup instead of the login', async () => {
    const error = Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403, data: { success: false, two_factor_setup_required: true } },
    });
    vi.spyOn(axiosConfig.holder, 'get').mockRejectedValue(error);
    const onError = vi.fn();
    const auth = makeAuth('/location/5/status');

    await axiosConfig.perform_get(auth, '/v1/thing/', vi.fn(), onError);

    expect(onError).toHaveBeenCalledWith(error);
    expect(auth.navigate).toHaveBeenCalledTimes(1);
    expect(auth.navigate).toHaveBeenCalledWith('/account/two-factor');
    expect(enqueueSnackbar).not.toHaveBeenCalled();
  });

  it('sends a user whose account awaits review to the review panel, not the login', async () => {
    const pending = () =>
      Object.assign(new Error('Request failed with status code 403'), {
        response: { status: 403, data: { success: false, reason: 'Account pending review', pending_review: true } },
      });
    vi.spyOn(axiosConfig.holder, 'get').mockImplementation(() => Promise.reject(pending()));
    const elsewhere = makeAuth('/location/5/status');
    const onPanel = makeAuth('/access/review');

    await axiosConfig.perform_get(elsewhere, '/api/auth-support/module-permissions/', vi.fn(), vi.fn());
    await axiosConfig.perform_get(onPanel, '/api/auth-support/module-permissions/', vi.fn(), vi.fn());

    expect(elsewhere.navigate).toHaveBeenCalledTimes(1);
    expect(elsewhere.navigate).toHaveBeenCalledWith('/access/review');
    // Already there: no loop through the login page.
    expect(onPanel.navigate).not.toHaveBeenCalled();
    expect(enqueueSnackbar).not.toHaveBeenCalled();
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

describe('403 - logged in, but not allowed', () => {
  const forbidden = (data: Record<string, unknown> = { success: false, reason: 'Missing required permissions' }) =>
    Object.assign(new Error('Request failed with status code 403'), { response: { status: 403, data } });

  it('keeps the user on the page and shows one error toast', async () => {
    const error = forbidden();
    vi.spyOn(axiosConfig.holder, 'get').mockRejectedValue(error);
    const onError = vi.fn();
    const auth = makeAuth('/location/5/status');

    await axiosConfig.perform_get(auth, '/v1/thing/', vi.fn(), onError);

    expect(onError).toHaveBeenCalledWith(error);
    expect(auth.navigate).not.toHaveBeenCalled();
    expect(enqueueSnackbar).toHaveBeenCalledTimes(1);
    expect(enqueueSnackbar).toHaveBeenCalledWith(i18n.t('permission_denied'), {
      variant: 'error',
      key: PERMISSION_DENIED_TOAST_KEY,
      preventDuplicate: true,
    });
  });

  it("leaves out the caller's own error toast - one toast per refusal", async () => {
    vi.spyOn(axiosConfig.holder, 'patch').mockRejectedValue(forbidden());
    const callerEnqueue = vi.fn();

    await axiosConfig.perform_patch(makeAuth(), '/v1/thing/1/', {}, vi.fn(), (error) =>
      showRequestError(callerEnqueue, 'Could not save', error),
    );

    expect(callerEnqueue).not.toHaveBeenCalled();
    expect(enqueueSnackbar).toHaveBeenCalledTimes(1);
    // Muted only while the 403's callback runs.
    showRequestError(callerEnqueue, 'Could not save', new Error('boom'));
    expect(callerEnqueue).toHaveBeenCalledTimes(1);
  });

  it('uses one toast key, so parallel refusals collapse into one toast', async () => {
    vi.spyOn(axiosConfig.holder, 'get').mockRejectedValue(forbidden());

    await Promise.all([
      axiosConfig.perform_get(makeAuth(), '/a', vi.fn(), vi.fn()),
      axiosConfig.perform_get(makeAuth(), '/b', vi.fn(), vi.fn()),
    ]);

    const keys = enqueueSnackbar.mock.calls.map(([, options]) => options.key);
    expect(keys).toEqual([PERMISSION_DENIED_TOAST_KEY, PERMISSION_DENIED_TOAST_KEY]);
    expect(enqueueSnackbar.mock.calls.every(([, options]) => options.preventDuplicate)).toBe(true);
  });

  it("names the server's reason when it says something", async () => {
    vi.spyOn(axiosConfig.holder, 'post').mockRejectedValue(forbidden({ reason: 'Staff access required' }));

    await axiosConfig.perform_post(makeAuth(), '/x', {}, vi.fn(), vi.fn());

    expect(enqueueSnackbar.mock.calls[0][0]).toBe(
      i18n.t('permission_denied_reason', { reason: 'Staff access required' }),
    );
    expect(enqueueSnackbar.mock.calls[0][0]).toContain('Staff access required');
  });

  it.each([{}, { detail: 'You do not have permission to perform this action.' }, { reason: '  ' }])(
    'falls back to the generic text for %o',
    async (data) => {
      vi.spyOn(axiosConfig.holder, 'get').mockRejectedValue(forbidden(data));

      await axiosConfig.perform_get(makeAuth(), '/x', vi.fn(), vi.fn());

      expect(enqueueSnackbar.mock.calls[0][0]).toBe(i18n.t('permission_denied'));
    },
  );

  it('toasts with the default callback too, and without an auth context', async () => {
    vi.spyOn(axiosConfig.holder, 'get').mockRejectedValue(forbidden());
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await axiosConfig.perform_get(undefined as unknown as AuthContextType, '/x', vi.fn());

    expect(enqueueSnackbar).toHaveBeenCalledTimes(1);
  });

  it("keeps a demo user's 403 to the caller (no toast, no login)", async () => {
    vi.spyOn(axiosConfig.holder, 'get').mockRejectedValue(forbidden());
    const onError = vi.fn();
    const auth = makeAuth('/location/5/status', { is_demo: true });

    await axiosConfig.perform_get(auth, '/x', vi.fn(), onError);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(auth.navigate).not.toHaveBeenCalled();
    expect(enqueueSnackbar).not.toHaveBeenCalled();
  });

  it.each([
    ['the read-only demo', { demo_read_only: true }, 'demo_read_only'],
    ['impersonation', { impersonation: true }, 'impersonation_blocked'],
  ])('keeps the hint for a write refused by %s', async (_name, data, key) => {
    vi.spyOn(axiosConfig.holder, 'post').mockRejectedValue(forbidden(data));
    const callerEnqueue = vi.fn();
    const auth = makeAuth();

    // With its own callback: the caller's toast, nothing from here.
    await axiosConfig.perform_post(auth, '/x', {}, vi.fn(), (error) =>
      showRequestError(callerEnqueue, 'Could not save', error),
    );
    expect(callerEnqueue).toHaveBeenCalledTimes(1);
    expect(enqueueSnackbar).not.toHaveBeenCalled();

    // Without one: the info hint.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await axiosConfig.perform_post(auth, '/x', {}, vi.fn());
    expect(enqueueSnackbar).toHaveBeenCalledWith(i18n.t(key), { variant: 'info' });
    expect(auth.navigate).not.toHaveBeenCalled();
  });
});

describe('expired access token', () => {
  it('refreshes it once and retries the original request', async () => {
    localStorage.setItem('authToken', 'old-access');
    localStorage.setItem('refreshToken', 'old-refresh');
    axiosConfig.updateToken();
    const refresh = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { access: 'new-access', refresh: 'new-refresh' },
    });
    const originalAdapter = axiosConfig.holder.defaults.adapter;
    let calls = 0;
    axiosConfig.holder.defaults.adapter = async (config) => {
      calls += 1;
      if (calls === 1) {
        const error = Object.assign(new Error('Unauthorized'), {
          config,
          response: { status: 401, data: {}, headers: {}, config, statusText: 'Unauthorized' },
        });
        throw error;
      }
      return { data: 'ok', status: 200, statusText: 'OK', headers: {}, config };
    };

    try {
      const response = await axiosConfig.holder.request({ url: '/v1/protected/' });

      expect(response.data).toBe('ok');
      expect(calls).toBe(2);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('authToken')).toBe('new-access');
      expect(localStorage.getItem('refreshToken')).toBe('new-refresh');
    } finally {
      axiosConfig.holder.defaults.adapter = originalAdapter;
    }
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

  it('calls the error callback on 403 and stays on the page', async () => {
    vi.spyOn(axiosConfig.holder, 'patch').mockRejectedValue(httpError(403));
    const onError = vi.fn();
    const auth = makeAuth('/a');

    await axiosConfig.perform_patch(auth, '/v1/thing/1/', {}, vi.fn(), onError);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(auth.navigate).not.toHaveBeenCalled();
    expect(enqueueSnackbar).toHaveBeenCalledTimes(1);
  });
});
