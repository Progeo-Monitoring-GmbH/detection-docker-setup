// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ok = (response: unknown) => void;

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  snackbar: vi.fn(),
}));

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: Ok) => ok({ data: api.get(url) }),
    perform_post: (_auth: unknown, url: string, body: unknown, ok: Ok, fail: (error: unknown) => void) =>
      api.post(url, body, ok, fail),
  },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => ({}) }));
vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: api.snackbar }) }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));

const { default: MergeProjectsModal, mergeProgress } = await import('./MergeProjectsModal');

const LOCATIONS = [
  { id: 11, project_id: 4700, name: 'Halle Nord' },
  { id: 12, project_id: 4701, name: 'Halle Süd' },
];

let container: HTMLDivElement;
let root: Root;
const onDone = vi.fn();
let jobState: Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  api.get.mockReset();
  api.post.mockReset();
  api.snackbar.mockReset();
  onDone.mockReset();
  jobState = { status: 'running', main: 11, project_id: 4700, parts: [12],
    progress: { step: 'device', part_index: 0, parts: 1, device: 'dm-7', device_index: 0, devices: 2 } };
  api.get.mockImplementation((url: string) =>
    url.includes('merge-job') ? { job: jobState } : { nr: null, free: null, suggestion: 9300 });
  api.post.mockImplementation((_url: string, _body: unknown, ok: Ok) =>
    ok({ data: { location: 11, project_id: 4700, job_id: 'job-1' } }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const render = async () => {
  await act(async () => {
    root.render(<MergeProjectsModal locations={LOCATIONS} onHide={vi.fn()} onDone={onDone} />);
  });
};

const byTestId = (id: string, key?: string) =>
  document.body.querySelector<HTMLElement>(`[data-testid="${id}"]${key ? `[data-test-key="${key}"]` : ''}`);
const click = (id: string, key?: string) =>
  act(async () => {
    byTestId(id, key)!.click();
  });

describe('MergeProjectsModal', () => {
  it('merges into a selected main project and follows the job to its end', async () => {
    await render();
    // The first selected location is proposed as the main project - no number to ask for.
    expect((byTestId('merge-projects-main-option', '11') as HTMLInputElement).checked).toBe(true);
    expect(byTestId('merge-projects-nr')).toBeNull();

    await click('merge-projects-main-option', '12');
    await click('merge-projects-confirm');

    expect(api.post.mock.calls[0].slice(0, 2)).toEqual(['/v1/location-selection/merge/', { ids: [11, 12], main: 12 }]);
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    expect(api.get).toHaveBeenCalledWith('/v1/location-selection/merge-job/?id=job-1');
    expect(byTestId('merge-projects-job')!.textContent).toContain('selection_merge_moving_device');
    expect(onDone).not.toHaveBeenCalled();

    jobState = { ...jobState, status: 'done', result: { parts: [], incomplete: [] } };
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(onDone).toHaveBeenCalledWith(11);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('asks for a free number for a new main project', async () => {
    await render();

    await click('merge-projects-main-new');

    expect((byTestId('merge-projects-nr') as HTMLInputElement).value).toBe('9300');
    // Not confirmed free yet: no merge.
    expect((byTestId('merge-projects-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps an incomplete merge in the dialog', async () => {
    jobState = { ...jobState, status: 'incomplete' };
    await render();
    await click('merge-projects-confirm');
    await act(async () => {
      vi.advanceTimersByTime(0);
    });

    expect(byTestId('merge-projects-incomplete')).not.toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('counts the progress over the parts and their devices', () => {
    expect(mergeProgress(null)).toBe(0);
    expect(mergeProgress({ status: 'running', main: 1, project_id: 1, parts: [2, 3],
      progress: { step: 'device', part_index: 1, parts: 2, device_index: 1, devices: 2 } })).toBe(75);
    expect(mergeProgress({ status: 'done', main: 1, project_id: 1, parts: [2] })).toBe(100);
  });
});
