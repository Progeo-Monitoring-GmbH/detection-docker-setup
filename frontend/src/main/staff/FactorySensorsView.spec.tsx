// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SensorsOverview, SiteMeasurement } from './factorySensors';

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

// The resizable columns watch their widths; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

type Ok = (response: unknown) => void;
type Fail = (error: unknown) => void;

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  snackbar: vi.fn(),
  // Stable like i18next's - effects depend on `t`.
  translation: {
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
    i18n: { language: 'de' },
  },
}));

vi.mock('../../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: Ok) =>
      ok({ data: api.get(url) }),
    perform_post: (
      _auth: unknown,
      url: string,
      body: unknown,
      ok: Ok,
      fail: Fail,
    ) => api.post(url, body, ok, fail),
  },
}));
const auth = vi.hoisted(() => ({}));
vi.mock('../../../hooks/CoreAuthProvider', () => ({ useAuth: () => auth }));
vi.mock('notistack', () => ({
  useSnackbar: () => ({ enqueueSnackbar: api.snackbar }),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => api.translation,
}));

const { default: FactorySensorsView } = await import('./FactorySensorsView');

const measurement = (changes: Partial<SiteMeasurement>): SiteMeasurement => ({
  id: 1,
  projekt: '1500',
  sensor: '000001',
  zeit: '2026-11-24T09:41:12Z',
  r_ohm: 87450,
  r_status: 'ok',
  r_werk_ohm: 88120,
  delta_prozent: -0.8,
  status: 'ok',
  tag_uid: null,
  tag_passt_nicht: false,
  identifizierung: 'nfc',
  geraet: 'A1B2C3',
  benutzer: 'm.mustermann',
  ...changes,
});

const OVERVIEW: SensorsOverview = {
  sensoren: [
    {
      id: 10,
      projekt: '1500',
      sensor: '000001',
      band: '4711',
      tag_uid: null,
      r_werk_ohm: 88120,
      gemessen_am: null,
      messungen: 2,
      letzte_messung: measurement({}),
    },
    {
      id: 11,
      projekt: '1500',
      sensor: '000002',
      band: '4711',
      tag_uid: null,
      r_werk_ohm: 91000,
      gemessen_am: null,
      messungen: 1,
      letzte_messung: measurement({
        id: 2,
        sensor: '000002',
        status: 'pruefen',
        delta_prozent: 5.1,
      }),
    },
    {
      id: 12,
      projekt: '24017',
      sensor: '000003',
      band: null,
      tag_uid: null,
      r_werk_ohm: 89400,
      gemessen_am: null,
      messungen: 0,
      letzte_messung: null,
    },
  ],
  ohne_werkswert: [
    {
      ...measurement({
        id: 7,
        sensor: '000999',
        status: 'unbekannt',
        r_werk_ohm: null,
        delta_prozent: null,
      }),
      werkswert_vorhanden: false,
    },
  ],
  kennzahlen: {
    sensoren: 3,
    ok: 1,
    pruefen: 1,
    defekt: 0,
    unbekannt: 0,
    ungemessen: 1,
    ohne_werkswert: 1,
  },
  projekte: ['1500', '24017'],
  toleranz_prozent: 5,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.snackbar.mockReset();
  api.get.mockImplementation((url: string) =>
    url.includes('/messungen/')
      ? {
          messungen: [
            measurement({}),
            measurement({
              id: 3,
              status: 'pruefen',
              delta_prozent: 6,
              zeit: '2026-11-20T08:00:00Z',
            }),
          ],
        }
      : OVERVIEW,
  );
  api.post.mockImplementation((_url: string, _body: unknown, ok: Ok) =>
    ok({ data: { angelegt: 1, aktualisiert: 0 } }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = async () => {
  await act(async () => {
    root.render(<FactorySensorsView />);
  });
};

const byTestId = (id: string, key?: string) =>
  document.body.querySelector<HTMLElement>(
    `[data-testid="${id}"]${key ? `[data-test-key="${key}"]` : ''}`,
  );
const allByTestId = (id: string) => [
  ...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const click = (id: string, key?: string) =>
  act(async () => {
    byTestId(id, key)!.click();
  });
const type = (id: string, value: string) =>
  act(async () => {
    const field = byTestId(id) as HTMLInputElement | HTMLTextAreaElement;
    const prototype =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
      field,
      value,
    );
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
const shownSensors = () =>
  allByTestId('factory-sensors-status-badge').map(
    (badge) => badge.dataset.testKey,
  );

describe('FactorySensorsView', () => {
  it('shows the counts and every sensor with the status of its newest measurement', async () => {
    await render();

    expect(api.get).toHaveBeenCalledWith('/v1/werk/sensoren/');
    expect(byTestId('factory-sensors-kpi-sensoren-value')!.textContent).toBe(
      '3',
    );
    expect(byTestId('factory-sensors-kpi-pruefen-value')!.textContent).toBe(
      '1',
    );
    expect(
      byTestId('factory-sensors-kpi-ohne_werkswert-value')!.textContent,
    ).toBe('1');
    expect(shownSensors()).toEqual(['10', '11', '12']);
    expect(byTestId('factory-sensors-status-badge', '11')!.textContent).toBe(
      'fs_status_pruefen',
    );
    expect(byTestId('factory-sensors-table')!.textContent).toContain('+5,1 %');
  });

  it('filters by status and reloads for a project', async () => {
    await render();

    await click('factory-sensors-status-option', 'ungemessen');
    expect(shownSensors()).toEqual(['12']);

    await act(async () => {
      const select = byTestId('factory-sensors-project') as HTMLSelectElement;
      select.value = '1500';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(api.get).toHaveBeenLastCalledWith('/v1/werk/sensoren/?projekt=1500');
  });

  it('lists measurements without factory values and creates them from there', async () => {
    await render();

    expect(byTestId('factory-sensors-unmatched')!.textContent).toContain(
      '000999',
    );
    await click('factory-sensors-unmatched-create', '7');

    expect(
      (byTestId('factory-sensor-create-projekt') as HTMLInputElement).value,
    ).toBe('1500');
    expect(
      (byTestId('factory-sensor-create-sensor') as HTMLInputElement).value,
    ).toBe('000999');
  });

  it('creates one sensor and reloads the page', async () => {
    await render();
    await click('factory-sensors-add');
    await type('factory-sensor-create-projekt', '1500');
    await type('factory-sensor-create-sensor', '4');
    await type('factory-sensor-create-r_werk_ohm', '88120');
    api.get.mockClear();

    await click('factory-sensor-create-submit');

    expect(api.post.mock.calls[0].slice(0, 2)).toEqual([
      '/v1/werk/sensoren/',
      {
        sensoren: [
          {
            projekt: '1500',
            sensor: '4',
            band: null,
            tag_uid: null,
            r_werk_ohm: 88120,
            gemessen_am: null,
          },
        ],
      },
    ]);
    expect(api.get).toHaveBeenCalledWith('/v1/werk/sensoren/');
    expect(byTestId('factory-sensor-create')).toBeNull();
  });

  it('marks the field the server refused', async () => {
    api.post.mockImplementation(
      (_url: string, _body: unknown, _ok: Ok, fail: Fail) =>
        fail({
          response: {
            status: 422,
            data: {
              fehler: 'ungueltig',
              meldung: 'Tag-UID muss Hex sein.',
              feld: 'sensoren[0].tag_uid',
            },
          },
        }),
    );
    await render();
    await click('factory-sensors-add');
    await type('factory-sensor-create-projekt', '1500');
    await type('factory-sensor-create-sensor', '4');
    await type('factory-sensor-create-tag_uid', 'xyz');
    await type('factory-sensor-create-r_werk_ohm', '88120');

    await click('factory-sensor-create-submit');

    expect(byTestId('factory-sensor-create-tag_uid')!.classList).toContain(
      'is-invalid',
    );
    expect(byTestId('factory-sensor-create')!.textContent).toContain(
      'Tag-UID muss Hex sein.',
    );
  });

  it('sends pasted CSV rows at once after the preview', async () => {
    await render();
    await click('factory-sensors-add');
    await click('factory-sensor-create-tab', 'csv');
    await type(
      'factory-sensor-create-csv',
      'projekt;sensor;band;tag_uid;r_werk_ohm\n1500;5;;;88000\n1500;6;;;89000',
    );

    expect(allByTestId('factory-sensor-create-preview-row')).toHaveLength(2);
    await click('factory-sensor-create-submit');

    expect(
      (api.post.mock.calls[0][1] as { sensoren: unknown[] }).sensoren,
    ).toHaveLength(2);
  });

  it('keeps CSV rows with errors from being sent', async () => {
    await render();
    await click('factory-sensors-add');
    await click('factory-sensor-create-tab', 'csv');
    await type('factory-sensor-create-csv', '1500;5;;;viel');

    expect(
      byTestId('factory-sensor-create-submit')!.hasAttribute('disabled'),
    ).toBe(true);
    expect(
      byTestId('factory-sensor-create-preview-row', '1')!.closest(
        '.rdt_TableRow',
      )!.classList,
    ).toContain('fs-preview-error');
  });

  it('opens the measurement history of a sensor', async () => {
    await render();

    await click('factory-sensors-history', '10');

    expect(api.get).toHaveBeenCalledWith('/v1/werk/sensoren/10/messungen/');
    expect(allByTestId('factory-sensor-history-row')).toHaveLength(2);
    expect(byTestId('factory-sensor-history')!.textContent).toContain(
      'm.mustermann',
    );
  });
});
