// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegacyConfig } from './LegacyGprsConfigPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));
const hooks = vi.hoisted(() => ({
  snackbar: { enqueueSnackbar: vi.fn() },
  translation: { t: (key: string) => key },
}));

vi.mock('../../axiosConfig', () => ({
  default: { updateToken: () => {}, holder: { get: api.get, post: api.post } },
}));
vi.mock('notistack', () => ({ useSnackbar: () => hooks.snackbar }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => hooks.translation,
}));

const {
  default: LegacyGprsConfigPanel,
  changedValues,
  legacyIntervalOptions,
} = await import('./LegacyGprsConfigPanel');

const CONFIG: LegacyConfig = {
  script: 'gprs_4060_h.php',
  role: 'main',
  project_id: 4060,
  second_project_id: 4061,
  editable: { interval: true, pull_resistance: true, sensor_count: true, pe: true },
  values: { interval: 300, pull_resistance: 40, sensor_count: 20, pe: true, main_interval: 300 },
  reply: 'xx0x2803000020081 0340x280-10\n\n',
  fields: { pd: '0x28', interval: 300, reset: '0', sensors: 20, earth: 1 },
  answered: true,
  missing: {},
};

let container: HTMLDivElement;
let root: Root;

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

const render = async (config: LegacyConfig = CONFIG, canEdit = true) => {
  api.get.mockResolvedValue({ data: config });
  await act(async () => {
    root.render(<LegacyGprsConfigPanel deviceId={7} locationId={3} canEdit={canEdit} testId="lc" />);
  });
};

const select = async (id: string, value: string) => {
  const element = byTestId(id) as HTMLSelectElement;
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api.get.mockReset();
  api.post.mockReset();
  hooks.snackbar.enqueueSnackbar.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('LegacyGprsConfigPanel', () => {
  it('loads the configuration of the device in its database', async () => {
    await render();

    expect(api.get).toHaveBeenCalledWith('/v1/device/7/legacy-config/', { params: { location: 3 } });
    expect(byTestId('lc-script')?.textContent).toBe('gprs_4060_h.php');
    expect(byTestId('lc-reply')?.textContent).toBe(CONFIG.reply.trim());
  });

  it('sends only the changed values and shows the new answer', async () => {
    await render();
    const saved = { ...CONFIG, values: { ...CONFIG.values, interval: 900 }, reply: 'xx0x2809000020081' };
    api.post.mockResolvedValue({ data: saved });

    await select('lc-interval', '900');
    await act(async () => {
      byTestId('lc-save')?.click();
    });

    expect(api.post).toHaveBeenCalledWith('/v1/device/7/legacy-config/?location=3', { interval: 900 });
    expect(byTestId('lc-reply')?.textContent).toBe('xx0x2809000020081');
  });

  it('cannot save without a change', async () => {
    await render();

    expect((byTestId('lc-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns when the controller is not answered', async () => {
    await render({ ...CONFIG, answered: false, reply: '', fields: null, missing: { 4061: ['sensor_count'] } });

    expect(byTestId('lc-reply')).toBeNull();
    expect(byTestId('lc-not-answered')?.textContent).toBe('legacycfg_not_answered');
  });

  it('a second project has no interval of its own', async () => {
    await render({ ...CONFIG, role: 'second', editable: { ...CONFIG.editable, interval: false } });

    expect(byTestId('lc-interval')).toBeNull();
    expect(byTestId('lc-second')).not.toBeNull();
  });

  it('is read only without module_devices_edit', async () => {
    await render(CONFIG, false);

    expect(byTestId('lc-save')).toBeNull();
    expect((byTestId('lc-interval') as HTMLSelectElement).disabled).toBe(true);
  });
});

describe('legacyIntervalOptions', () => {
  it('only offers intervals that fit 4 digits and keeps an unusual current one', () => {
    const values = legacyIntervalOptions(1200).map((option) => option.value);

    expect(values[0]).toBe(1200);
    expect(Math.max(...values)).toBeLessThanOrEqual(9999);
    expect(values).toContain(1800);
  });
});

describe('changedValues', () => {
  it('ignores what the device may not change', () => {
    const second = { ...CONFIG, editable: { ...CONFIG.editable, interval: false } };

    expect(
      changedValues(second, { interval: 900, pull_resistance: 136, sensor_count: '20', pe: true }),
    ).toEqual({ pull_resistance: 136 });
  });
});
