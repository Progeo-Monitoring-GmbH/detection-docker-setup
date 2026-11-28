// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** GET requests: held until the test answers them (status per answer). */
const api = vi.hoisted(() => ({
  urls: [] as string[],
  held: [] as { url: string; answer: (status?: number) => void }[],
}));
vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (
      _auth: unknown,
      url: string,
      ok: (response: unknown) => void,
      fail: (error: unknown) => void,
    ) => {
      api.urls.push(url);
      api.held.push({
        url,
        answer: (status = 200) =>
          status === 200
            ? ok({ data: url.includes('/climate/') ? { devices: [] } : { count: 0 } })
            : fail({ response: { status } }),
      });
      return Promise.resolve();
    },
    perform_post: vi.fn(),
  },
}));
const auth = vi.hoisted(() => ({ value: { user: {} as Record<string, unknown> } }));
vi.mock('../../hooks/CoreAuthProvider.tsx', () => ({ useAuth: () => auth.value }));
vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: vi.fn() }) }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../components/device/ClimateChart', () => ({
  default: () => <div data-testid="stub-chart" />,
}));

const { default: LocationClimatePanels } = await import('./LocationClimatePanels');

let container: HTMLDivElement;
let root: Root;
const onReady = vi.fn();

const render = (props: { revision?: number; kind?: 'leak' | 'climate' } = {}) =>
  act(() => {
    root.render(<LocationClimatePanels locationId={7} onReady={onReady} {...props} />);
  });
const answer = (path: string, status = 200) =>
  act(() => {
    const index = api.held.findIndex((request) => request.url.includes(path));
    expect(index).toBeGreaterThanOrEqual(0);
    api.held.splice(index, 1)[0].answer(status);
  });
const climateRequests = () => api.urls.filter((url) => url.includes('/climate/'));
const spinner = () => container.querySelector('[data-testid="climate-panels-humidity-loading"]');

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.urls = [];
  api.held = [];
  onReady.mockClear();
  auth.value = { user: {} };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('LocationClimatePanels - in a tab', () => {
  it('reports ready with the first answer and reloads quietly on a new revision', () => {
    render({ revision: 0 });
    expect(spinner()).not.toBeNull();
    expect(onReady).not.toHaveBeenCalled();

    answer('/climate/');
    expect(onReady).toHaveBeenCalled();
    expect(climateRequests()).toHaveLength(1);

    render({ revision: 1 });
    expect(climateRequests()).toHaveLength(2);
    // The charts stay while the new data loads.
    expect(spinner()).toBeNull();
  });

  it('reports ready also when the data is refused', () => {
    render();
    answer('/climate/', 403);
    expect(onReady).toHaveBeenCalled();
  });

  it('superusers get the measurement tools only in a pure climate object', () => {
    // They act on every measurement of the location - in a leak object's
    // Klima tab "delete all" would wipe the leak history too.
    auth.value = { user: { is_superuser: true } };
    const tool = (name: string) => container.querySelector(`[data-testid="climate-panels-${name}"]`);
    render();
    expect(tool('clean')).not.toBeNull();
    expect(tool('export')).not.toBeNull();

    render({ kind: 'climate' });
    expect(tool('clean')).toBeNull();
    expect(tool('export')).toBeNull();
    expect(tool('import')).toBeNull();
    // Renaming the devices stays.
    expect(tool('rename-devices')).not.toBeNull();
  });

  it('asks for the range of its kind', () => {
    render({ kind: 'climate' });
    expect(api.urls).toContain('/v1/location/7/measurement-range/?kind=climate');
  });
});
