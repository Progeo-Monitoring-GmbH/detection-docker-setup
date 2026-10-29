// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosError } from 'axios';
import {
  backendReachable,
  checkBackend,
  HEARTBEAT_MS,
  isMaintenance,
  reportRequestError,
  resetMaintenance,
  RETRY_MS,
  startMaintenanceWatch,
} from './maintenance';

const answer = (status: number, type: ResponseType = 'basic') =>
  ({ status, type }) as Response;
const axiosError = (fields: Partial<AxiosError>) => fields as AxiosError;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetMaintenance();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('backendReachable', () => {
  it('probes the health endpoint without cache', async () => {
    fetchMock.mockResolvedValue(answer(204));
    expect(await backendReachable()).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/health\/$/);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      cache: 'no-store',
      mode: 'no-cors',
    });
  });

  it.each([502, 503, 504])(
    'counts nginx gateway error %i as gone',
    async (status) => {
      fetchMock.mockResolvedValue(answer(status));
      expect(await backendReachable()).toBe(false);
    },
  );

  it('counts any other answer as there, also a refusal or an opaque one', async () => {
    fetchMock.mockResolvedValue(answer(403));
    expect(await backendReachable()).toBe(true);
    fetchMock.mockResolvedValue(answer(0, 'opaque'));
    expect(await backendReachable()).toBe(true);
  });

  it('counts no connection as gone, a timeout (busy backend) as there', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await backendReachable()).toBe(false);
    fetchMock.mockRejectedValue(
      Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    );
    expect(await backendReachable()).toBe(true);
  });
});

describe('reportRequestError', () => {
  it("switches at once on nginx's maintenance answer", () => {
    reportRequestError(
      axiosError({
        response: { status: 503, data: { code: 'maintenance' } } as never,
      }),
    );
    expect(isMaintenance()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('probes on a request without answer and switches when the probe fails too', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    reportRequestError(axiosError({ code: 'ERR_NETWORK' }));
    await checkBackend();
    expect(isMaintenance()).toBe(true);
  });

  it('stays when the probe gets an answer', async () => {
    fetchMock.mockResolvedValue(answer(204));
    reportRequestError(axiosError({ response: { status: 502 } as never }));
    await checkBackend();
    expect(isMaintenance()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a cancelled request', { code: 'ERR_CANCELED' }],
    ['a timed-out request', { code: 'ECONNABORTED' }],
    ['an ordinary error', { response: { status: 500 } as never }],
  ])('ignores %s', (_, fields) => {
    reportRequestError(axiosError(fields));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isMaintenance()).toBe(false);
  });

  it('does not probe while the browser is offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    reportRequestError(axiosError({ code: 'ERR_NETWORK' }));
    expect(await checkBackend()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('checkBackend', () => {
  it('runs one probe at a time', async () => {
    fetchMock.mockResolvedValue(answer(204));
    await Promise.all([checkBackend(), checkBackend(), checkBackend()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('startMaintenanceWatch', () => {
  it('notices a gone backend by the heartbeat and reloads once it is back', async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const stop = startMaintenanceWatch(reload);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(isMaintenance()).toBe(true);

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(reload).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(answer(204));
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it('retries quickly as soon as a request reports maintenance', async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    fetchMock.mockResolvedValue(answer(204));
    const stop = startMaintenanceWatch(reload);

    reportRequestError(
      axiosError({
        response: { status: 503, data: { code: 'maintenance' } } as never,
      }),
    );
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stops probing after the cleanup', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(answer(204));
    startMaintenanceWatch(vi.fn())();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
