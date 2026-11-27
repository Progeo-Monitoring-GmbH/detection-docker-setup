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
            m5: { sensors: 4, interval_sec: 300, poll_sec: 300, threshold_mv: { '136': 891, '72': 450, '40': 76, '24': 8 } },
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
            ? { config_format: 'm5', config_filename: 'platform_config.h' }
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
  auth: {},
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

beforeEach(() => {
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

  it('shows the whole config only on request', () => {
    click(one('device-provision-generate'));

    expect(one('device-provision-config')).toBeNull();

    click(one('device-provision-show-config'));

    expect(one('device-provision-config')?.textContent).toBe('return {}');
  });

  describe('M5 AIN4', () => {
    const pickM5 = () => {
      click(one('device-provision-sections-edit', 'device'));
      const select = one('device-provision-model') as HTMLSelectElement;
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
        setter.call(select, 'M5 AIN4');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      save();
    };

    it('shows the m5 config type, sends threshold and poll, hides wifi/portal/firmware/qr', () => {
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
      expect(one('device-provision-show-config-qr')).toBeNull();
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

    it('offers the config as a download named platform_config.h', () => {
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
      expect(names).toEqual(['platform_config.h']);
      clickSpy.mockRestore();
    });
  });
});
