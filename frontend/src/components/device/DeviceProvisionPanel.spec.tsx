// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { duplicateTestIds } from '../../testIds';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** "Gerät hinzufügen": the config's sections as cards, each with its dialog. */

const api = vi.hoisted(() => ({ previews: [] as Record<string, unknown>[] }));
vi.mock('../../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, _url: string, ok: (response: unknown) => void) => {
      ok({
        data: {
          locations: [{ id: 7, project_id: 1312, name: 'Halle', project_type: 'smartex mx', model: 'smartex mx', alarm_threshold: 100 }],
          models: ['smartex mx', 'smartex vt', 'M5 AIN4'],
          defaults: {
            sensors: 32,
            interval_sec: 1800,
            pulldown_resistance: 136,
            firmware: null,
            m5: { sensors: 4, interval_sec: 300, poll_sec: 300, rs485_enabled: false, threshold_mv: { '136': 891, '72': 450, '40': 76, '24': 8 } },
          },
          m5_model: 'M5 AIN4',
          firmware_bundles: [],
          firmware_fallback: 'v1.6.1',
          pulldown_resistances: [
            { value: 136, label: '100k' },
            { value: 72, label: '10k' },
            { value: 8, label: 'off' },
          ],
        },
      });
      return Promise.resolve();
    },
    perform_post: (_auth: unknown, _url: string, data: Record<string, unknown>, ok: (response: unknown) => void) => {
      api.previews.push(data);
      const code = { payload: 'x', image: 'data:image/png;base64,QQ==' };
      const m5 = data.config_format === 'm5';
      ok({
        data: {
          ...(m5
            // No filename: the page names the M5's file itself (config.py).
            ? { config_format: 'm5', config_qr: code.image, config_qr_text: '# progeo:m5-config:1\n' }
            : { config_format: 'lua', config_filename: 'config.lua', config_qr: code.image, portal: { wifi: { ...code, ssid: 'Helper' }, frontend: { ...code, url: 'http://192.168.16.1' } } }),
          device_hash: '1312-01',
          project_id: 1312,
          model: data.model,
          firmware_version: 'v1.6.1',
          firmware_bundle: null,
          token: `token${api.previews.length}`,
          url: 'https://api.progeo.com/v1/device/1312/sample/',
          config: 'return {}',
          signed: 'signed',
        },
      });
      return Promise.resolve();
    },
  },
}));
const hooks = vi.hoisted(() => ({
  auth: { user: { is_staff: true } } as { user: { is_staff?: boolean; is_superuser?: boolean } },
  snackbar: { enqueueSnackbar: () => undefined },
  translation: {
    t: (key: string, options?: { section?: string }) => (options?.section ? `${key}:${options.section}` : key),
  },
}));
vi.mock('../../../hooks/CoreAuthProvider', () => ({ useAuth: () => hooks.auth }));
vi.mock('notistack', () => ({ useSnackbar: () => hooks.snackbar }));
vi.mock('react-i18next', () => ({ useTranslation: () => hooks.translation }));
vi.mock('../ui/Snackbar.jsx', () => ({
  showErrorBar: () => undefined,
  showRequestError: () => undefined,
  showSuccessBar: () => undefined,
}));

const { default: DeviceProvisionPanel } = await import('./DeviceProvisionPanel');

let container: HTMLDivElement;
let root: Root;

const one = (id: string, key?: string) =>
  document.body.querySelector<HTMLElement>(`[data-testid="${id}"]${key ? `[data-test-key="${key}"]` : ''}`);
const card = (name: string) => one('device-provision-sections-card', name);
const click = (element: HTMLElement | null) => {
  expect(element).not.toBeNull();
  act(() => element!.click());
};
const type = (id: string, value: string) => {
  const input = one(id) as HTMLInputElement;
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const save = () => click(one('device-provision-sections-dialog-confirm'));
const choose = (id: string, value: string) => {
  const select = one(id) as HTMLSelectElement;
  expect(select).not.toBeNull();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const modelOptions = () =>
  [...(one('device-provision-model') as HTMLSelectElement).options].map((option) => option.value);

beforeEach(() => {
  hooks.auth = { user: { is_staff: true } };
  api.previews.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<DeviceProvisionPanel locationId={7} onCreated={() => undefined} onClose={() => undefined} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the config sections of "Gerät hinzufügen"', () => {
  it('shows a card per section and no config text', () => {
    const names = [...document.body.querySelectorAll('[data-testid="device-provision-sections-card"]')].map(
      (element) => element.getAttribute('data-test-key'),
    );

    expect(names).toEqual(['wifi', 'device', 'measurement', 'control', 'firmware']);
    expect(card('measurement')?.textContent).toContain('100k (136)');
    expect(card('device')?.textContent).toContain('1312');
    expect(card('device')?.textContent).toContain('provision_generated_later');
    expect(document.body.querySelector('textarea')).toBeNull();
    // Nothing to choose without a bundle on the server.
    expect(one('device-provision-sections-edit', 'firmware')).toBeNull();
    expect(duplicateTestIds(document.body)).toEqual([]);
  });

  it('changes a section in its dialog; cancel keeps the values', () => {
    click(one('device-provision-sections-edit', 'measurement'));
    type('device-provision-sensors', '64');
    click(one('device-provision-sections-dialog-cancel'));

    expect(card('measurement')?.textContent).toContain('32');

    click(one('device-provision-sections-edit', 'measurement'));
    type('device-provision-sensors', '0');

    expect((one('device-provision-sections-dialog-confirm') as HTMLButtonElement).disabled).toBe(true);

    type('device-provision-sensors', '64');
    click(one('device-provision-protective-earth'));
    save();

    expect(one('device-provision-sections-dialog')).toBeNull();
    expect(card('measurement')?.textContent).toContain('64');
    expect(api.previews).toEqual([]); // nothing was generated yet

    click(one('device-provision-generate'));

    expect(api.previews[0]).toMatchObject({ location: 7, sensors: 64, protective_earth: 1, router_user: '' });
    expect(one('device-provision-hash')?.textContent).toBe('1312-01');
    expect(one('device-provision-token')?.textContent).toBe('token1');
    expect(card('portal')).not.toBeNull();
    expect(duplicateTestIds(document.body)).toEqual([]);
  });

  it('adds the optional router section, masks its password and removes it again', () => {
    click(one('device-provision-sections-add', 'router'));

    // An empty section cannot be saved.
    expect((one('device-provision-sections-dialog-confirm') as HTMLButtonElement).disabled).toBe(true);

    type('device-provision-router-user', 'admin');
    type('device-provision-router-pwd', 'secret');
    save();

    expect(card('router')?.textContent).toContain('admin');
    expect(card('router')?.textContent).not.toContain('secret');
    expect(one('device-provision-sections-add', 'router')).toBeNull();

    click(one('device-provision-generate'));

    expect(api.previews[0]).toMatchObject({ router_user: 'admin', router_pwd: 'secret' });

    // A change with a config on screen generates it again.
    click(one('device-provision-sections-remove', 'router'));

    expect(card('router')).toBeNull();
    expect(api.previews[1]).toMatchObject({ router_user: '', router_pwd: '' });
    expect(one('device-provision-token')?.textContent).toBe('token2');
    expect(one('device-provision-sections-add', 'router')).not.toBeNull();
  });

  it("preselects the location's device type and offers the others beside it", () => {
    const select = one('device-provision-model') as HTMLSelectElement;

    // Outside the cards' dialogs - visible at once.
    expect(select.closest('[data-testid="device-provision-sections-dialog"]')).toBeNull();
    expect(select.value).toBe('smartex mx');
    expect(modelOptions()).toEqual(['smartex mx', 'smartex vt', 'M5 AIN4']);
    expect(select.options[0].textContent).toBe('provision_device_type_location');
  });

  it('adds another device type than the location\'s', () => {
    choose('device-provision-model', 'smartex vt');

    expect(card('device')?.textContent).toContain('smartex vt');
    click(one('device-provision-generate'));
    expect(api.previews[0]).toMatchObject({ config_format: 'lua', model: 'smartex vt' });

    // A config on screen is generated again for the new type.
    choose('device-provision-model', 'smartex mx');
    expect(api.previews[1]).toMatchObject({ model: 'smartex mx' });
  });

  it('shows the whole config only on request', () => {
    click(one('device-provision-generate'));

    expect(one('device-provision-config')).toBeNull();

    click(one('device-provision-show-config'));

    expect(one('device-provision-config')?.textContent).toBe('return {}');
  });

  describe('M5 AIN4', () => {
    const pickM5 = () => choose('device-provision-model', 'M5 AIN4');

    it('shows the m5 config type, sends threshold and poll, hides wifi/portal/firmware', () => {
      pickM5();

      expect(one('device-provision-config-format')?.textContent).toContain('m5');
      expect(card('wifi')).toBeNull();
      expect(card('firmware')).toBeNull();
      expect(one('device-provision-threshold')).not.toBeNull();
      expect(one('device-provision-threshold-mismatch')?.textContent).toContain('provision_threshold_mismatch');

      click(one('device-provision-generate'));

      expect(api.previews[0]).toMatchObject({
        config_format: 'm5',
        threshold_mv: 891,
        poll_sec: 300,
        model: 'M5 AIN4',
      });
      expect(card('portal')).toBeNull();
    });

    it('shows the m5 config QR code with the flasher app hint', () => {
      pickM5();
      click(one('device-provision-generate'));
      click(one('device-provision-show-config-qr'));

      expect(one('device-provision-config-qr')?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,QQ==');
      expect(one('device-provision-config-qr-m5-hint')?.textContent).toBe('provision_m5_qr_caption');
    });

    const selectValue = choose;

    it('shows the RS485 card for M5 only, the project field once enabled, and sends both values', () => {
      expect(card('rs485')).toBeNull();
      pickM5();

      expect(card('rs485')?.textContent).toContain('provision_rs485_title');
      click(one('device-provision-sections-edit', 'rs485'));
      expect(one('device-provision-rs485-project')).toBeNull();
      click(one('device-provision-rs485-enabled'));
      expect(one('device-provision-rs485-project')).not.toBeNull();
      type('device-provision-rs485-project', '2001');
      // No interval of its own: the climate sensors send at the M5's.
      expect(one('device-provision-rs485-interval')).toBeNull();
      save();
      click(one('device-provision-generate'));

      expect(api.previews[0]).toMatchObject({
        rs485_enabled: true,
        rs485_project_id: 2001,
      });
      expect(api.previews[0]).not.toHaveProperty('rs485_interval_sec');
    });

    it('RS485 without a project number: the M5 project, explained under the field', () => {
      pickM5();
      click(one('device-provision-sections-edit', 'rs485'));
      click(one('device-provision-rs485-enabled'));
      expect(document.body.textContent).toContain('provision_rs485_project_hint');
      type('device-provision-rs485-project', '0');
      expect((one('device-provision-sections-dialog-confirm') as HTMLButtonElement).disabled).toBe(true);
      type('device-provision-rs485-project', '');
      save();
      // The card names where the values go instead of "–".
      expect(card('rs485')?.textContent).toContain('provision_rs485_project_default');
      click(one('device-provision-generate'));

      expect(api.previews[0]).toMatchObject({ rs485_enabled: true });
      expect(api.previews[0]).not.toHaveProperty('rs485_project_id');
    });

    it('sends RS485 disabled and no project by default', () => {
      pickM5();
      click(one('device-provision-generate'));

      expect(api.previews[0]).toMatchObject({ rs485_enabled: false });
      expect(api.previews[0]).not.toHaveProperty('rs485_project_id');
    });

    it('labels the M5 rows through t(), not raw keys', () => {
      pickM5();

      expect(card('device')?.textContent).toContain('provision_config_format');
      expect(card('measurement')?.textContent).toContain('provision_threshold_mv');
      expect(card('measurement')?.textContent).toContain('provision_poll_sec');
      const labels = [...(card('measurement')?.querySelectorAll('dt') ?? [])].map((dt) => dt.textContent);
      expect(labels).not.toContain('threshold_mv');
      expect(labels).not.toContain('poll_sec');
    });

    it('switches the config type: m5 sets the M5 model, lua restores the location model', () => {
      click(one('device-provision-sections-edit', 'device'));
      selectValue('device-provision-config-format-select', 'm5');
      save();
      click(one('device-provision-generate'));

      expect(api.previews[0]).toMatchObject({ config_format: 'm5', model: 'M5 AIN4', threshold_mv: 891 });

      click(one('device-provision-sections-edit', 'device'));
      selectValue('device-provision-config-format-select', 'lua');
      save();
      click(one('device-provision-generate'));

      expect(api.previews[1]).toMatchObject({ config_format: 'lua', model: 'smartex mx' });
    });

    it('Lua after M5 sends the location defaults again, not the M5 ones', () => {
      pickM5();
      click(one('device-provision-sections-edit', 'device'));
      selectValue('device-provision-config-format-select', 'lua');
      save();
      click(one('device-provision-generate'));

      expect(api.previews[0]).toMatchObject({
        config_format: 'lua',
        model: 'smartex mx',
        sensors: 32,
        interval_sec: 1800,
        pulldown_resistance: 136,
        protective_earth: 0,
        rpi: false,
      });
    });

    it('Lua after M5 by model keeps the location defaults too', () => {
      pickM5();
      selectValue('device-provision-model', 'smartex vt');
      click(one('device-provision-generate'));

      expect(api.previews[0]).toMatchObject({ config_format: 'lua', model: 'smartex vt', sensors: 32, interval_sec: 1800 });
      for (const key of ['rs485_enabled', 'rs485_project_id', 'rs485_interval_sec']) {
        expect(api.previews[0]).not.toHaveProperty(key);
      }
    });

    it('offers the M5 to staff only', () => {
      expect(modelOptions()).toContain('M5 AIN4');
      click(one('device-provision-sections-edit', 'device'));
      expect([...(one('device-provision-config-format-select') as HTMLSelectElement).options].map((o) => o.value)).toContain('m5');
      click(one('device-provision-sections-dialog-cancel'));

      act(() => root.unmount());
      hooks.auth = { user: { is_staff: false } };
      root = createRoot(container);
      act(() => root.render(<DeviceProvisionPanel locationId={7} onCreated={() => undefined} onClose={() => undefined} />));
      expect(modelOptions()).not.toContain('M5 AIN4');
      click(one('device-provision-sections-edit', 'device'));
      expect([...(one('device-provision-config-format-select') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['lua']);
    });

    it('blocks generate for an empty or out-of-range threshold', () => {
      pickM5();
      click(one('device-provision-sections-edit', 'measurement'));
      type('device-provision-threshold-input', '');

      expect((one('device-provision-sections-dialog-confirm') as HTMLButtonElement).disabled).toBe(true);

      type('device-provision-threshold-input', '0');

      expect((one('device-provision-sections-dialog-confirm') as HTMLButtonElement).disabled).toBe(true);
      click(one('device-provision-sections-dialog-cancel'));
      click(one('device-provision-generate'));

      expect(api.previews[0]).toMatchObject({ threshold_mv: 891 });
    });

    it('keeps a hand-edited threshold when the pulldown changes', () => {
      pickM5();
      click(one('device-provision-sections-edit', 'measurement'));
      type('device-provision-threshold-input', '500');
      save();
      click(one('device-provision-sections-edit', 'measurement'));
      selectValue('device-provision-resistance', '72');
      save();
      click(one('device-provision-generate'));

      expect(api.previews[0]).toMatchObject({ pulldown_resistance: 72, threshold_mv: 500 });
    });

    it('follows the pulldown default threshold until edited by hand', () => {
      pickM5();
      click(one('device-provision-sections-edit', 'measurement'));
      const select = one('device-provision-resistance') as HTMLSelectElement;
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
        setter.call(select, '72');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      save();
      click(one('device-provision-generate'));

      expect(api.previews[0]).toMatchObject({ pulldown_resistance: 72, threshold_mv: 450 });
    });

    it('offers the config as a download named config.py (MicroPython)', () => {
      pickM5();
      click(one('device-provision-generate'));
      const create = vi.fn(() => 'blob:x');
      const revoke = vi.fn();
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
      const names: string[] = [];
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        names.push(this.download);
      });

      click(one('device-provision-download-config'));

      expect(create).toHaveBeenCalled();
      expect(names).toEqual(['config.py']);
      clickSpy.mockRestore();
    });
  });
});
