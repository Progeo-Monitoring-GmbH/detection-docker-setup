// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockerContainer } from './DockerStatusView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  containers: [] as DockerContainer[],
  get: vi.fn(),
  post: vi.fn(),
  // POST answers by action; an Error is the request's failure.
  answers: {} as Record<string, unknown>,
}));
const hooks = vi.hoisted(() => ({
  auth: {},
  snackbar: { enqueueSnackbar: vi.fn() },
  translation: {
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key),
  },
}));

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: (response: unknown) => void) => {
      api.get(url);
      ok({ data: { container: api.containers } });
    },
    perform_post: (
      _auth: unknown,
      url: string,
      body: unknown,
      ok: (response: unknown) => void,
      failed: (error: unknown) => void,
    ) => {
      api.post(url, body);
      const answer = api.answers[url];
      if (answer instanceof Error) {
        failed(answer);
      } else {
        ok({ data: answer ?? { success: true } });
      }
    },
  },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => hooks.auth }));
vi.mock('notistack', () => ({ useSnackbar: () => hooks.snackbar }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => hooks.translation,
}));

const { default: DockerStatusView } = await import('./DockerStatusView');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.get.mockClear();
  api.post.mockClear();
  hooks.snackbar.enqueueSnackbar.mockClear();
  api.answers = {};
  api.containers = [
    { id: 'aaaaaaaaaaaa1111', name: 'web', status: 'running', image: 'progeo/web', started_at: null, health: 'healthy' },
    { id: 'bbbbbbbbbbbb2222', name: 'worker', status: 'exited', image: 'progeo/worker', started_at: null, health: null },
  ];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = () =>
  act(() => {
    root.render(<DockerStatusView />);
  });
const byLabel = (label: string, index = 0) =>
  document.querySelectorAll<HTMLButtonElement>(`[aria-label="${label}"]`)[index];
const click = (element: Element) => act(() => (element as HTMLElement).click());

describe('DockerStatusView', () => {
  it('lists the containers with their status', () => {
    render();
    expect(api.get).toHaveBeenCalledWith('/api/docker/status/');
    expect(container.textContent).toContain('web');
    expect(container.textContent).toContain('worker');
    expect(container.textContent).toContain('docker_running_count:{"running":1,"total":2}');
  });

  it('stops a running and starts a stopped container - then reloads the list', () => {
    render();
    click(byLabel('docker_action_stop'));
    expect(api.post).toHaveBeenCalledWith('/api/docker/stop/', { container_id: 'aaaaaaaaaaaa1111' });
    click(byLabel('docker_action_start'));
    expect(api.post).toHaveBeenCalledWith('/api/docker/start/', { container_id: 'bbbbbbbbbbbb2222' });
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it('shows the logs - no crash', () => {
    api.answers['/api/docker/logs/'] = { success: true, name: 'web', logs: '2026-11-05 started\n', tail: 1000 };
    render();
    click(byLabel('docker_action_logs'));
    expect(api.post).toHaveBeenCalledWith('/api/docker/logs/', { container_id: 'aaaaaaaaaaaa1111', tail: 1000 });
    expect(document.querySelector('[data-testid="docker-logs"]')!.textContent).toBe('2026-11-05 started\n');
  });

  it('reports a failed action with the reason of the server', () => {
    api.answers['/api/docker/stop/'] = Object.assign(new Error('400'), {
      response: { data: { reason: 'Container not found' } },
    });
    render();
    click(byLabel('docker_action_stop'));
    const [message, options] = hooks.snackbar.enqueueSnackbar.mock.calls.at(-1)!;
    expect(message).toContain('Container not found');
    expect(options).toMatchObject({ variant: 'error' });
  });

  it('removes only stopped containers, after asking', () => {
    render();
    expect(byLabel('docker_remove_running_hint').disabled).toBe(true);
    click(byLabel('docker_action_remove'));
    expect(api.post).not.toHaveBeenCalled();
    const confirmButton = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'docker_action_remove',
    )!;
    click(confirmButton);
    expect(api.post).toHaveBeenCalledWith('/api/docker/remove/', { container_id: 'bbbbbbbbbbbb2222' });
  });
});
