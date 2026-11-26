// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlaggedEntry, ProductionOverview } from './production';

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
  plots: [] as Array<{ data: Array<Record<string, unknown>> }>,
  translation: {
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
    i18n: { language: 'de' },
  },
}));

vi.mock('../../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: Ok, fail: Fail) => {
      const data = api.get(url);
      return data && 'fail' in data ? fail(data.fail) : ok({ data });
    },
    perform_post: (
      _auth: unknown,
      url: string,
      body: unknown,
      ok: Ok,
      fail: Fail,
    ) => api.post(url, body, ok, fail),
  },
}));
// Stable like the real context value - the page loads again when it changes.
const auth = vi.hoisted(() => ({}));
vi.mock('../../../hooks/CoreAuthProvider', () => ({ useAuth: () => auth }));
vi.mock('notistack', () => ({
  useSnackbar: () => ({ enqueueSnackbar: api.snackbar }),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => api.translation,
}));
vi.mock('react-plotly.js', () => ({
  default: (props: { data: Array<Record<string, unknown>> }) => {
    api.plots.push(props);
    return <div data-testid="plot" />;
  },
}));

const { default: ProductionView } = await import('./ProductionView');

const value = (ohm: number | null, flag: 'ok' | 'warn' | 'bad', status = 'ok') => ({
  ohm,
  status,
  flag,
});

const flagged = (changes: Partial<FlaggedEntry>): FlaggedEntry => ({
  sensor_record_id: 'recSENS0000000003',
  sensor: '001132',
  auftrag_id: 'PROD_dm-Breitband_7099_97',
  order_record_id: 'recORDER000000097',
  projekt: 7099,
  werte: {
    r_platine: value(99870, 'ok'),
    r_aufgespult: value(100120, 'ok'),
    r_kurzschluss: value(180, 'bad'),
  },
  stufe: 'fehler',
  erfasst_am: '2026-11-26T09:41:12Z',
  kuerzel: 'DW',
  blatt: 1,
  bestaetigt: true,
  nach_freigabe_geaendert: false,
  qs: { status: 'Prüfen', manuell: false, von: null, am: '2026-11-26T11:02:40Z' },
  ...changes,
});

const OVERVIEW: ProductionOverview = {
  kennzahlen: {
    sensoren_heute: 3,
    messband_heute_m: 88.5,
    vorlauf_heute_m: 85.05,
    erfasst: 702,
    gesamt: 1834,
    auftraege: 1,
    fehler: 1,
    warnungen: 1,
    qs_offen: 2,
  },
  tage: [
    { datum: '2026-11-25', sensoren: 0, messband_m: 0, vorlauf_m: 0 },
    { datum: '2026-11-26', sensoren: 3, messband_m: 88.5, vorlauf_m: 85.05 },
  ],
  auftraege: [
    {
      id: 'recORDER000000097',
      auftrag_id: 'PROD_dm-Breitband_7099_97',
      nr: 97,
      projekt: '7099',
      objekt: 'BDK1 und BDK2 De Soto',
      erfasst: 702,
      gesamt: 1834,
      blaetter_freigegeben: 35,
      blaetter: 92,
      fehler: 1,
      warnungen: 1,
      qs_offen: 2,
      zuletzt: '2026-11-26T09:41:12Z',
    },
  ],
  auffaellig: [
    flagged({}),
    flagged({
      sensor_record_id: 'recSENS0000000004',
      sensor: '001133',
      stufe: 'warnung',
      bestaetigt: false,
      werte: {
        r_platine: value(75000, 'warn'),
        r_aufgespult: value(100120, 'ok'),
        r_kurzschluss: value(90, 'ok'),
      },
    }),
    flagged({
      sensor_record_id: 'recSENS0000000021',
      sensor: '001150',
      blatt: null,
      bestaetigt: false,
      qs: null,
      werte: {
        r_platine: value(99870, 'ok'),
        r_aufgespult: value(null, 'bad', 'offen'),
        r_kurzschluss: value(90, 'ok'),
      },
    }),
  ],
  rollen: [
    {
      nummer: 'MB-0142',
      typ: 'messband',
      kabeltyp: null,
      nennlaenge_m: 200,
      start_metrierung_m: null,
      metrierung_m: null,
      rest_m: 52.5,
      leer: false,
      code: null,
      code_format: null,
      fotos: ['/v1/werk/rollen/fotos/1/'],
      zuletzt: {
        geraet_id: 'tablet-1',
        benutzer: 'd.werk',
        auftrag_id: 'PROD_dm-Breitband_7099_97',
        am: '2026-11-26T09:41:12Z',
      },
      sensoren: 6,
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.snackbar.mockReset();
  api.plots.length = 0;
  api.get.mockImplementation(() => OVERVIEW);
  api.post.mockImplementation((_url: string, _body: unknown, ok: Ok) =>
    ok({ data: { eintraege: [] } }),
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
    root.render(<ProductionView />);
  });
};

const byTestId = (id: string, key?: string) =>
  document.body.querySelector<HTMLElement>(
    `[data-testid="${id}"]${key ? `[data-test-key="${key}"]` : ''}`,
  );
const keysOf = (id: string) =>
  [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)].map(
    (element) => element.dataset.testKey,
  );
const click = (id: string, key?: string) =>
  act(async () => {
    byTestId(id, key)!.click();
  });

describe('ProductionView', () => {
  it('loads the overview of the last 14 days and shows its figures', async () => {
    await render();

    expect(api.get).toHaveBeenCalledWith('/v1/werk/produktion/?tage=14');
    expect(byTestId('production-kpi-erfasst-value')!.textContent).toBe('702 / 1834');
    expect(byTestId('production-kpi-fehler-value')!.textContent).toBe('1');
    expect(byTestId('production-kpi-qs_offen-value')!.textContent).toBe('2');
  });

  it('charts measuring band and lead cable per day', async () => {
    await render();

    const [band, lead] = api.plots[api.plots.length - 1].data;
    expect(band.x).toEqual(['2026-11-25', '2026-11-26']);
    expect(band.y).toEqual([0, 88.5]);
    expect(lead.y).toEqual([0, 85.05]);
  });

  it('lists bad values and warnings apart', async () => {
    await render();

    expect(keysOf('production-bad-sensor')).toEqual([
      'recSENS0000000003',
      'recSENS0000000021',
    ]);
    expect(keysOf('production-warning-sensor')).toEqual(['recSENS0000000004']);
  });

  it('lets staff decide the QS check of a released sensor only', async () => {
    await render();

    expect(byTestId('production-qs-ok', 'recSENS0000000021')).toBeNull();
    await click('production-qs-rework', 'recSENS0000000003');

    expect(api.post).toHaveBeenCalledWith(
      '/v1/werk/produktion/qs/',
      { sensor_record_ids: ['recSENS0000000003'], qs: 'Nacharbeit' },
      expect.any(Function),
      expect.any(Function),
    );
    // Reloaded after the decision.
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('narrows the page to an order', async () => {
    await render();

    await click('production-order-row', 'recORDER000000097');

    expect(api.get).toHaveBeenLastCalledWith(
      '/v1/werk/produktion/?tage=14&auftrag=recORDER000000097',
    );
  });

  it('shows the rolls with their sensors and rest', async () => {
    await render();

    expect(keysOf('production-roll')).toEqual(['MB-0142']);
    expect(byTestId('production-roll', 'MB-0142')!.textContent).toContain('MB-0142');
  });
});
