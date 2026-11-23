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
  { id: 'recDwg', name: 'FCX_403018_B.dwg', kind: 'dwg', size: 214853, type: null,
    created: '2026-10-01T08:00:00.000Z', modified: '2026-11-18T14:30:00.000Z' },
  { id: 'recRouter', name: 'Router_Daten.txt', kind: 'router', size: 201, type: null,
    created: '2026-10-01T08:00:00.000Z', modified: null },
  { id: 'recKlemm', name: 'Klemmliste_dm_Gebrüder_Weiss.pdf', kind: 'klemmliste', size: 206334, type: null, created: null },
  { id: 'recModel', name: 'MEA-Modell.pdf', kind: 'pdf', size: 5000, type: null, created: null },
  { id: 'recLayoutDwg', name: 'Verlegeplan.dwg', kind: 'dwg', group: 'drawings', size: 9000, type: null, created: null },
  { id: 'recLayoutPdf', name: 'Verlegeplan.pdf', kind: 'pdf', group: 'drawings', size: 9000, type: null, created: null },
];
const PROJECT_URL = 'https://airtable.com/appX/tblY/recProject';
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
  api.get.mockImplementation(() => ({ project_found: true, project_url: PROJECT_URL, documents: DOCUMENTS }));
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
    expect(names).toEqual(['recDwg', 'recRouter', 'recKlemm', 'recModel', 'recLayoutDwg', 'recLayoutPdf']);
    // MEA-Dokumente and Zeichnungen (Verlegplan) - one list each.
    const drawings = byTestId('lageplan-wizard-mea-group', 'drawings')!;
    expect(drawings.textContent).toContain('Zeichnungen (Verlegplan)');
    expect(drawings.querySelectorAll('[data-testid="lageplan-wizard-mea-document"]')).toHaveLength(2);
    // A Verlegplan PDF is no Klemmliste - downloadable, not readable.
    expect(byTestId('lageplan-wizard-mea-read', 'recLayoutPdf')).toBeNull();
    expect(byTestId('lageplan-wizard-mea-download', 'recLayoutPdf')).not.toBeNull();
    // The project opens in Airtable, in a new tab.
    const link = byTestId('lageplan-wizard-mea-airtable-link') as HTMLAnchorElement;
    expect(link.href).toBe(PROJECT_URL);
    expect(link.target).toBe('_blank');
    // Every PDF can be read - a Klemmliste isn't always named so; the plan and the router data can't.
    expect(byTestId('lageplan-wizard-mea-read', 'recDwg')).toBeNull();
    expect(byTestId('lageplan-wizard-mea-read', 'recRouter')).toBeNull();
    expect(byTestId('lageplan-wizard-mea-read', 'recModel')).not.toBeNull();
    // When the record was last changed in Airtable - its creation until it was; nothing without either.
    expect(byTestId('lageplan-wizard-mea-changed', 'recDwg')!.textContent).toMatch(/^changed .*2026/);
    expect(byTestId('lageplan-wizard-mea-changed', 'recRouter')!.textContent).toMatch(/^added .*2026/);
    expect(byTestId('lageplan-wizard-mea-changed', 'recModel')).toBeNull();

    await click('lageplan-wizard-mea-download', 'recDwg');

    expect(api.download.mock.calls[0].slice(1)).toEqual([
      '/v1/status/measure_points/airtable_documents/download/?location_id=7078&document=recDwg',
      'FCX_403018_B.dwg',
    ]);
  });

  it("reads the documents of another project number - a merged project's source", async () => {
    await render();
    const field = byTestId('lageplan-wizard-mea-project-number') as HTMLInputElement;
    expect(field.placeholder).toBe('7078');

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '51a80');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Digits only.
    expect(field.value).toBe('5180');
    await click('lageplan-wizard-mea-project-load');

    expect(api.get).toHaveBeenLastCalledWith(
      '/v1/status/measure_points/airtable_documents/?location_id=7078&project_number=5180',
    );
    // Download and reading name the same project; the names still go onto location 7078.
    await click('lageplan-wizard-mea-download', 'recDwg');
    expect(api.download.mock.calls[0][1]).toBe(
      '/v1/status/measure_points/airtable_documents/download/?location_id=7078&document=recDwg&project_number=5180',
    );
    await click('lageplan-wizard-mea-read', 'recKlemm');
    expect(api.post.mock.calls[0][1]).toEqual({ location_id: 7078, document: 'recKlemm', project_number: '5180' });

    // Back to the location's own project.
    await click('lageplan-wizard-mea-project-own');
    expect(api.get).toHaveBeenLastCalledWith('/v1/status/measure_points/airtable_documents/?location_id=7078');
    expect(byTestId('lageplan-wizard-mea-project-own')).toBeNull();
  });

  it('names the other project number when Airtable has no such project', async () => {
    await render();
    api.get.mockImplementation(() => ({ project_found: false, project_url: null, documents: [] }));
    const field = byTestId('lageplan-wizard-mea-project-number') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '9999');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('lageplan-wizard-mea-project-load');

    expect(byTestId('lageplan-wizard-mea-no-project')!.textContent).toBe('No Airtable project with the number 9999.');
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
    expect(dry[1]).toEqual({
      location_id: 7078, job_id: 'job-airtable', device_id: null, strategy: 'points', dry_run: true,
    });
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

  it('takes the suggested sensor mapping once the location has measurements', async () => {
    const mapping = {
      ...PREVIEW,
      strategy: 'map',
      mode: 'map',
      suggested_strategy: 'map',
      mappings: [{
        unit: null, device_id: 8, device_label: 'smartex dm (#8)', remapped: 1, changed: 1,
        positions: [
          { position: 1, mux: 1, pin: 1, sensor: 'D_1', sensor_order: 1, formula: 1, current: 1 },
          { position: 3, mux: 1, pin: 3, sensor: 'D_2', sensor_order: 2, formula: 3, current: 3 },
        ],
        unmapped_inputs: [2],
        manual_conflicts: [{ position: 4, klemmliste: 3, manual: null }],
      }],
    };
    api.post.mockImplementation((url: string, body: Record<string, unknown>, ok: Ok) => {
      if (url.endsWith('/klemmliste/')) {
        ok({ data: { job_id: 'job-map' } });
      } else if (body.strategy === 'map') {
        ok({ data: { result: body.dry_run ? mapping : { ...mapping, updated: 1 }, applied: !body.dry_run } });
      } else {
        ok({ data: { result: { ...PREVIEW, strategy: 'points', suggested_strategy: 'map' } } });
      }
    });
    await render();
    await click('lageplan-wizard-mea-read', 'recKlemm');
    await act(async () =>
      api.finishJob!({ job_id: 'job-map', status: 'done', source_name: 'k.pdf', result: { rows: ROWS, warnings: [] },
        log: [], error: null }),
    );

    // Asked as "points" first, then again with the suggestion.
    expect(api.post.mock.calls.slice(1).map((call) => (call[1] as { strategy: string }).strategy)).toEqual(['points', 'map']);
    expect((byTestId('lageplan-wizard-klemmliste-strategy-map') as HTMLInputElement).checked).toBe(true);
    expect(byTestId('lageplan-wizard-klemmliste-mapping', '8')!.textContent).toContain('1 differ from the formula');
    expect(byTestId('lageplan-wizard-klemmliste-unmapped')!.textContent).toContain('2');
    expect(byTestId('lageplan-wizard-klemmliste-manual-conflicts')!.textContent).toContain('input 4 is sensor none');

    await click('lageplan-wizard-klemmliste-apply');

    expect(api.post.mock.calls[api.post.mock.calls.length - 1][1]).toMatchObject({ strategy: 'map', dry_run: false });
    expect(onNamesApplied).toHaveBeenCalledTimes(1);

    // Back to renumbering on request.
    await click('lageplan-wizard-klemmliste-strategy-points');
    expect(api.post.mock.calls[api.post.mock.calls.length - 1][1]).toMatchObject({ strategy: 'points', dry_run: true });
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

  it('puts the measuring units on the devices, checks their sensor counts and lets one be changed', async () => {
    const units = {
      mode: 'name',
      moves: [],
      conflicts: [],
      changes: [
        { position: 1, mux: 1, pin: 1, sensor_order: 1, new: '1', old: null, points: 1, unit: 'Area A' },
        { position: 1, mux: 1, pin: 1, sensor_order: 201, new: '107', old: null, points: 1, unit: 'Area B' },
      ],
      unchanged: [],
      missing: [],
      without_name: [],
      units: [
        { unit: 'Area A', rows: 105, device_id: 5, device_label: 'Controller A', first_sensor_order: 1,
          last_sensor_order: 105, sensor_count: 105, count_matches: true },
        { unit: 'Area B', rows: 82, device_id: 6, device_label: 'Controller B', first_sensor_order: 201,
          last_sensor_order: 282, sensor_count: 80, count_matches: false },
      ],
      unit_warnings: ['Area B: 82 sensor(s) in the list, Controller B measures 80'],
      unassigned: 0,
      device_updates: [{ unit: 'Area B', device_id: 6, device_label: 'Controller B',
        first_sensor_order: [1, 106], sensor_count: [80, 80] }],
      rows_total: 187,
      point_orders: { count: 187, min: 1, max: 283 },
    };
    api.post.mockImplementation((_url: string, _body: Record<string, unknown>, ok: Ok) => ok({ data: { result: units } }));
    await render({ devices: [{ id: 5, label: 'Controller A' }, { id: 6, label: 'Controller B', first_sensor_order: 201 }] });

    await act(async () =>
      api.finishUpload!(
        { rows: [{ ...ROWS[0], unit: 'Area A' }, { ...ROWS[0], sensor: '107', unit: 'Area B' }], warnings: [] },
        { job_id: 'job-units', status: 'done', result: null, log: [], error: null },
      ),
    );

    // One picker per unit instead of the single device picker.
    expect(byTestId('lageplan-wizard-klemmliste-device')).toBeNull();
    expect(byTestId('lageplan-wizard-klemmliste-unit', 'Area B')!.className).toContain('--warning');
    expect(byTestId('lageplan-wizard-klemmliste-unit', 'Area B')!.textContent).toContain('80 ≠ 82');
    expect(byTestId('lageplan-wizard-klemmliste-unit-warnings')!.textContent).toContain('Controller B measures 80');
    expect(byTestId('lageplan-wizard-klemmliste-total')!.textContent).toContain('187 sensor(s) in the list, 187');
    expect(byTestId('lageplan-wizard-klemmliste-device-update', '6')!.textContent).toBe(
      'Area B → Controller B: first sensor 1 → 106',
    );
    // 2 name changes + 1 device update.
    expect(byTestId('lageplan-wizard-klemmliste-apply')!.textContent).toContain('Apply 3 change(s)');
    // Positions repeat per unit - the lines are told apart by it.
    expect(byTestId('lageplan-wizard-klemmliste-line', 'Area A-1')).not.toBeNull();
    expect(byTestId('lageplan-wizard-klemmliste-line', 'Area B-1')).not.toBeNull();

    const select = byTestId('lageplan-wizard-klemmliste-unit-device', 'Area A') as HTMLSelectElement;
    await act(async () => {
      select.value = '6';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const last = api.post.mock.calls[api.post.mock.calls.length - 1];
    expect(last[1]).toMatchObject({ job_id: 'job-units', unit_devices: { 'Area A': 6, 'Area B': 6 }, dry_run: true });
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
    expect(last[1]).toEqual({
      location_id: 7078, job_id: 'job-upload', device_id: 6, strategy: 'points', dry_run: true,
    });
  });

  it('shows no Airtable documents to non-staff and asks nothing', async () => {
    await render({ staff: false });

    expect(api.get).not.toHaveBeenCalled();
    expect(byTestId('lageplan-wizard-mea-documents')).toBeNull();
    expect(byTestId('upload-stub')).not.toBeNull();
  });
});
