// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scoreboard } from './qaScoreboardData';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// DataTable follows the colour scheme; jsdom has no matchMedia.
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  awards: [] as unknown[],
}));
const hooks = vi.hoisted(() => ({
  auth: { token: 'x', canViewAsUser: true, user: { user_id: 7 } } as Record<
    string,
    unknown
  >,
  snackbar: { enqueueSnackbar: vi.fn() },
  translation: {
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  },
}));

const board: Scoreboard = {
  mean: [
    { day: '2026-11-16', score: 61.5, locations: 40 },
    { day: '2026-11-18', score: 64, locations: 41 },
  ],
  users: [
    {
      id: 4,
      username: 'anna',
      total: 6.5,
      count: 2,
      awards: [
        {
          at: '2026-11-17T09:00:00Z',
          points: 4,
          check_key: 'product',
          location_id: 1,
          project_id: 4700,
          location_name: 'Halle 1',
        },
        {
          at: '2026-11-18T09:00:00Z',
          points: 2.5,
          check_key: 'geo',
          location_id: 1,
          project_id: 4700,
          location_name: 'Halle 1',
        },
      ],
    },
    { id: 2, username: 'ben', total: 0, count: 0, awards: [] },
  ],
  unattributed: { total: 3, count: 1 },
  now: '2026-11-18T12:00:00Z',
};

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (
      _auth: unknown,
      url: string,
      ok: (response: unknown) => void,
    ) => {
      api.get(url);
      ok({ data: board });
      return Promise.resolve();
    },
    perform_post: (
      _auth: unknown,
      url: string,
      _body: unknown,
      ok: (response: unknown) => void,
    ) => {
      api.post(url);
      ok({ data: { awards: api.awards } });
      return Promise.resolve();
    },
  },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => hooks.auth }));
vi.mock('notistack', () => ({ useSnackbar: () => hooks.snackbar }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => hooks.translation,
}));
// Plotly doesn't run in jsdom - the chart is its own (lazy) module.
vi.mock('./QaScoreboardChart', () => ({
  default: ({ board: shown }: { board: Scoreboard }) => (
    <div data-testid="qa-chart">{shown.users.length}</div>
  ),
}));

/** The live socket (/ws/qa/) - its messages are sent by the tests. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  close() {
    this.onclose?.();
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
(globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;

const { default: QaScoreboard } = await import('./QaScoreboard');
const { QaAwardToasts } = await import('./QaAwardToasts');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.get.mockClear();
  api.post.mockClear();
  api.awards = [];
  hooks.snackbar.enqueueSnackbar.mockClear();
  hooks.auth = { token: 'x', canViewAsUser: true, user: { user_id: 7 } };
  FakeSocket.instances = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byTestId = (id: string) =>
  container.querySelector(`[data-testid="${id}"]`);

describe('QaScoreboard', () => {
  it('loads only on "Load scoreboard" and shows the KPIs, the chart and the ranking', async () => {
    act(() => root.render(<QaScoreboard />));
    expect(api.get).not.toHaveBeenCalled();
    expect(byTestId('qa-scoreboard-table')).toBeNull();

    await act(async () => {
      (byTestId('qa-scoreboard-load') as HTMLButtonElement).click();
    });

    expect(api.get).toHaveBeenCalledWith('/v1/qa/scoreboard/');
    expect(byTestId('qa-kpi-mean-value')?.textContent).toMatch(/^64[.,]0/);
    expect(byTestId('qa-kpi-change-value')?.textContent).toMatch(/^\+2[.,]5/);
    expect(byTestId('qa-chart')?.textContent).toBe('2');
    const names = [...container.querySelectorAll('.qa-scoreboard-user')].map(
      (cell) => cell.textContent,
    );
    expect(names).toEqual(['anna', 'ben']);
    expect(byTestId('qa-scoreboard-load')?.textContent).toContain(
      'qa_scoreboard_reload',
    );
  });
});

describe('QaAwardToasts', () => {
  it('toasts the points a staff member just earned', async () => {
    api.awards = [
      {
        id: 1,
        check_key: 'product',
        points: 4,
        location_id: 1,
        project_id: 4700,
        location_name: 'Halle 1',
      },
    ];

    await act(async () => root.render(<QaAwardToasts />));

    expect(api.post).toHaveBeenCalledWith('/v1/qa/notifications/');
    expect(hooks.snackbar.enqueueSnackbar).toHaveBeenCalledWith(
      expect.stringContaining('qa_toast_one'),
      {
        variant: 'success',
      },
    );
  });

  it('looks again right after a checklist check, quietly when nothing is new', async () => {
    await act(async () => root.render(<QaAwardToasts />));
    api.post.mockClear();

    await act(async () => {
      window.dispatchEvent(new Event('progeo:qa-checked'));
    });

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(hooks.snackbar.enqueueSnackbar).not.toHaveBeenCalled();
  });

  it('asks nothing for customers', async () => {
    hooks.auth = { token: 'x', canViewAsUser: false };

    await act(async () => root.render(<QaAwardToasts />));

    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('live updates', () => {
  it('fetches the toast at once when the socket names the user', async () => {
    await act(async () => root.render(<QaAwardToasts />));
    const socket = FakeSocket.instances[0];
    expect(socket.url).toMatch(/\/ws\/qa\/$/);
    act(() => socket.onopen?.());
    api.post.mockClear();
    const updates: unknown[] = [];
    const listen = (event: Event) =>
      updates.push((event as CustomEvent).detail);
    window.addEventListener('progeo:qa-updated', listen);

    await act(async () =>
      socket.emit({ type: 'qa_update', user_ids: [3], reason: 'award' }),
    );
    expect(api.post).not.toHaveBeenCalled();
    await act(async () =>
      socket.emit({ type: 'qa_update', user_ids: [7], reason: 'award' }),
    );
    expect(api.post).toHaveBeenCalledWith('/v1/qa/notifications/');
    await act(async () => socket.emit({ type: 'heartbeat' }));

    window.removeEventListener('progeo:qa-updated', listen);
    expect(updates).toEqual([
      { user_ids: [3], reason: 'award' },
      { user_ids: [7], reason: 'award' },
    ]);
  });

  it('reloads a loaded scoreboard after a change - an unloaded one stays unloaded', async () => {
    vi.useFakeTimers();
    try {
      act(() => root.render(<QaScoreboard />));
      await act(async () => {
        window.dispatchEvent(new CustomEvent('progeo:qa-updated'));
        vi.advanceTimersByTime(1000);
      });
      expect(api.get).not.toHaveBeenCalled();

      await act(async () => {
        (byTestId('qa-scoreboard-load') as HTMLButtonElement).click();
      });
      expect(api.get).toHaveBeenCalledTimes(1);
      await act(async () => {
        window.dispatchEvent(new CustomEvent('progeo:qa-updated'));
        window.dispatchEvent(new CustomEvent('progeo:qa-updated'));
        vi.advanceTimersByTime(1000);
      });
      // A burst of changes: one reload.
      expect(api.get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
