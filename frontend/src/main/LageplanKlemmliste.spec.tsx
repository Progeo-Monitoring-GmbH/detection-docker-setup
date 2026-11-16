// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ok = (response: unknown) => void;
type Job = { job_id: string; status: string; source_name?: string; result: unknown; log: string[]; error: null };

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  download: vi.fn(),
  // The job view's / dropbox's finish callbacks, to end a job by hand.
  finishJob: null as null | ((job: Job) => void),
  finishUpload: null as null | ((result: unknown, job: Job) => void),
}));

const DOCUMENTS = [
  { id: 'recDwg', name: 'FCX_403018_B.dwg', kind: 'dwg', size: 214853, type: null, created: null },
  { id: 'recRouter', name: 'Router_Daten.txt', kind: 'router', size: 201, type: null, created: null },
  { id: 'recKlemm', name: 'Klemmliste_dm_Gebrüder_Weiss.pdf', kind: 'klemmliste', size: 206334, type: null, created: null },
  { id: 'recModel', name: 'MEA-Modell.pdf', kind: 'pdf', size: 5000, type: null, created: null },
];
const ROWS = [
  { sensor: 'D_124', mux: 1, pin: 1, position: 1, page: 1 },
  { sensor: 'D_123', mux: 1, pin: 2, position: 2, page: 1 },
  { sensor: 'D_104', mux: 2, pin: 1, position: 17, page: 1 },
];
const PREVIEW = {
  changes: [{ position: 1, mux: 1, pin: 1, sensor_order: 1, new: 'D_124', old: 'dm 1', points: 2 }],
  unchanged: [{ position: 2, mux: 1, pin: 2, sensor_order: 2, new: 'D_123', old: 'D_123', points: 1 }],
  missing: [{ position: 17, mux: 2, pin: 1, sensor: 'D_104', sensor_order: 17 }],
  without_name: [3],
  point_orders: { count: 3, min: 1, max: 104 },
  named_like_points: 1,
};

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: Ok) => ok({ data: api.get(url) }),
    perform_post: (_auth: unknown, url: string, body: unknown, ok: Ok, fail: (error: unknown) => void) =>
      api.post(url, body, ok, fail),
  },
}));
vi.mock('../helper', () => ({ downloadResponse: (...args: unknown[]) => api.download(...args) }));
vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: vi.fn() }) }));
vi.mock('../components/form/CadUploadDropbox', () => ({
  default: ({ callBackProcessing }: { callBackProcessing: (result: unknown, job: Job) => void }) => {
    api.finishUpload = callBackProcessing;
    return <div data-testid="upload-stub" />;
  },
  CadJobView: ({ jobId, onFinished }: { jobId: string; onFinished: (job: Job) => void }) => {
    api.finishJob = onFinished;
    return <div data-testid="job-stub" data-job={jobId} />;
  },
}));

const { default: LageplanKlemmliste } = await import('./LageplanKlemmliste');

let container: HTMLDivElement;
let root: Root;
const onNamesApplied = vi.fn();

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.download.mockReset();
  onNamesApplied.mockReset();
  api.get.mockImplementation(() => ({ project_found: true, documents: DOCUMENTS }));
  api.post.mockImplementation((url: string, body: Record<string, unknown>, ok: Ok) => {
    if (url.endsWith('/klemmliste/')) {
      ok({ data: { job_id: 'job-airtable' } });
    } else if (body.dry_run) {
      ok({ data: { result: PREVIEW } });
    } else {
      ok({ data: { result: { ...PREVIEW, updated: 2 }, applied: true } });
    }
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = async (props: Partial<React.ComponentProps<typeof LageplanKlemmliste>> = {}) => {
  await act(async () => {
    root.render(
      <LageplanKlemmliste
        auth={{} as never}
        locationId={7078}
        devices={[]}
        staff
        onNamesApplied={onNamesApplied}
        {...props}
      />,
    );
  });
};

const byTestId = (id: string, key?: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${id}"]${key ? `[data-test-key="${key}"]` : ''}`);
const click = (id: string, key?: string) =>
  act(async () => {
    byTestId(id, key)!.click();
  });

describe('LageplanKlemmliste', () => {
  it("lists the project's MEA documents and downloads one through the backend", async () => {
    await render();

    expect(api.get).toHaveBeenCalledWith('/v1/status/measure_points/airtable_documents/?location_id=7078');
    const names = [...container.querySelectorAll('[data-testid="lageplan-wizard-mea-document"]')].map(
      (row) => row.getAttribute('data-test-key'),
    );
    expect(names).toEqual(['recDwg', 'recRouter', 'recKlemm', 'recModel']);
    // Every PDF can be read - a Klemmliste isn't always named so; the plan and the router data can't.
    expect(byTestId('lageplan-wizard-mea-read', 'recDwg')).toBeNull();
    expect(byTestId('lageplan-wizard-mea-read', 'recRouter')).toBeNull();
    expect(byTestId('lageplan-wizard-mea-read', 'recModel')).not.toBeNull();

    await click('lageplan-wizard-mea-download', 'recDwg');

    expect(api.download.mock.calls[0].slice(1)).toEqual([
      '/v1/status/measure_points/airtable_documents/download/?location_id=7078&document=recDwg',
      'FCX_403018_B.dwg',
    ]);
  });

  it('reads the Klemmliste from Airtable, previews and applies the names', async () => {
    await render();

    await click('lageplan-wizard-mea-read', 'recKlemm');
    expect(api.post.mock.calls[0].slice(0, 2)).toEqual([
      '/v1/status/measure_points/klemmliste/',
      { location_id: 7078, document: 'recKlemm' },
    ]);
    expect(byTestId('job-stub')!.dataset.job).toBe('job-airtable');

    await act(async () =>
      api.finishJob!({ job_id: 'job-airtable', status: 'done', source_name: 'Klemmliste.pdf',
        result: { rows: ROWS, warnings: ['Page 1: one twice'] }, log: [], error: null }),
    );

    const dry = api.post.mock.calls[1];
    expect(dry[0]).toBe('/v1/status/measure_points/klemmliste/apply/');
    expect(dry[1]).toEqual({ location_id: 7078, job_id: 'job-airtable', device_id: null, dry_run: true });
    const states = [...container.querySelectorAll('[data-testid="lageplan-wizard-klemmliste-line"]')].map(
      (row) => [row.getAttribute('data-test-key'), row.className.replace(/.*--/, '')],
    );
    expect(states).toEqual([['1', 'change'], ['2', 'same'], ['17', 'missing']]);
    expect(byTestId('lageplan-wizard-klemmliste-warnings')!.textContent).toContain('one twice');
    expect(byTestId('lageplan-wizard-klemmliste-unnamed')!.textContent).toContain('3');
    // A missing position keeps its MUX / PIN - and the numbering mismatch is explained.
    const missing = byTestId('lageplan-wizard-klemmliste-line', '17')!;
    expect(missing.querySelectorAll('td')[1].textContent).toBe('2 / 1');
    const mismatch = byTestId('lageplan-wizard-klemmliste-mismatch')!.textContent;
    expect(mismatch).toContain('numbered 1–104');
    expect(mismatch).toContain('numbered by their plan label');
    expect(byTestId('lageplan-wizard-klemmliste-apply')!.textContent).toContain('Apply 1 change(s)');

    await click('lageplan-wizard-klemmliste-apply');

    expect(api.post.mock.calls[2][1]).toMatchObject({ job_id: 'job-airtable', dry_run: false });
    expect(onNamesApplied).toHaveBeenCalledTimes(1);
    expect((byTestId('lageplan-wizard-klemmliste-apply') as HTMLButtonElement).disabled).toBe(true);
  });

  it('moves label-numbered points to their input (renumber mode) and names the conflicts', async () => {
    const renumber = {
      mode: 'renumber',
      moves: [
        { position: 1, mux: 1, pin: 1, from_order: 124, sensor_order: 1, new: 'D_124', old: 'dm 124', points: 1 },
        { position: 2, mux: 1, pin: 2, from_order: 123, sensor_order: 2, new: 'D_123', old: null, points: 1 },
      ],
      conflicts: [{ position: 17, mux: 2, pin: 1, sensor: 'D_104', from_order: 104, sensor_order: 17 }],
      changes: [],
      unchanged: [],
      missing: [],
      without_name: [],
      point_orders: { count: 4, min: 17, max: 124 },
      named_like_points: 3,
    };
    api.post.mockImplementation((_url: string, body: Record<string, unknown>, ok: Ok) =>
      ok({ data: { result: body.dry_run ? renumber : { ...renumber, updated: 2 } } }),
    );
    await render();

    await act(async () =>
      api.finishUpload!({ rows: ROWS, warnings: [] },
        { job_id: 'job-upload', status: 'done', result: null, log: [], error: null }),
    );

    const move = byTestId('lageplan-wizard-klemmliste-line', '1')!;
    expect(move.className).toContain('--move');
    expect(move.querySelectorAll('td')[3].textContent).toBe('#124 → #1');
    expect(move.querySelectorAll('td')[1].textContent).toBe('1 / 1');
    expect(byTestId('lageplan-wizard-klemmliste-line', '17')!.className).toContain('--conflict');
    expect(byTestId('lageplan-wizard-klemmliste-renumber')).not.toBeNull();
    expect(byTestId('lageplan-wizard-klemmliste-conflicts')!.textContent).toContain('1 sensor(s)');
    // In renumber mode the numbers are explained above - no "no measure point" hint.
    expect(byTestId('lageplan-wizard-klemmliste-mismatch')).toBeNull();
    expect(byTestId('lageplan-wizard-klemmliste-apply')!.textContent).toContain('Apply 2 change(s)');

    await click('lageplan-wizard-klemmliste-apply');

    expect(onNamesApplied).toHaveBeenCalledTimes(1);
    expect(byTestId('lageplan-wizard-klemmliste-line', '1')!.className).toContain('--same');
  });

  it('previews again for another device of the location', async () => {
    await render({ devices: [{ id: 5, label: 'Controller A' }, { id: 6, label: 'Controller B', first_sensor_order: 26 }] });

    await act(async () =>
      api.finishUpload!({ rows: ROWS, warnings: [] },
        { job_id: 'job-upload', status: 'done', result: null, log: [], error: null }),
    );
    const select = byTestId('lageplan-wizard-klemmliste-device') as HTMLSelectElement;
    await act(async () => {
      select.value = '6';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const last = api.post.mock.calls[api.post.mock.calls.length - 1];
    expect(last[1]).toEqual({ location_id: 7078, job_id: 'job-upload', device_id: 6, dry_run: true });
  });

  it('shows no Airtable documents to non-staff and asks nothing', async () => {
    await render({ staff: false });

    expect(api.get).not.toHaveBeenCalled();
    expect(byTestId('lageplan-wizard-mea-documents')).toBeNull();
    expect(byTestId('upload-stub')).not.toBeNull();
  });
});
