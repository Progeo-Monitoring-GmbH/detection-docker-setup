// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { duplicateTestIds } from '../testIds';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Wizard step 2: the overview and the sections of the devices' inputs. */

const ANSWER = {
  sensors: [1, 2, 3, 4, 5, 6],
  devices: [
    { device_id: 11, label: '7025-01 · smartex dm', hardware: 'smartex dm', first_sensor_order: 1, sensor_count: 3,
      measured_inputs: 3, mapped: false,
      inputs: [1, 2, 3].map((order) => ({ position: order, sensor_order: order, source: 'formula' })) },
    { device_id: 12, label: '7025-02 · smartex dm', hardware: 'smartex dm', first_sensor_order: 4, sensor_count: 2,
      measured_inputs: 2, mapped: false,
      inputs: [4, 5].map((order, index) => ({ position: index + 1, sensor_order: order, source: 'formula' })) },
  ],
};

const api = vi.hoisted(() => ({ posts: [] as Record<string, unknown>[] }));
vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, _url: string, ok: (response: unknown) => void) => ok({ data: ANSWER }),
    perform_post: (_auth: unknown, _url: string, data: Record<string, unknown>, ok: (response: unknown) => void) => {
      api.posts.push(data);
      ok({ data: { ...ANSWER, connected: 6 } });
    },
  },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => ({}) }));
vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: () => undefined }) }));
vi.mock('../components/ui/Snackbar.jsx', () => ({ showRequestError: () => undefined, showSuccessBar: () => undefined }));
// The step card without the wizard's fold panel and translations.
vi.mock('./LageplanWizardComponents', () => ({
  StepCard: ({ actions, children }: { actions?: ReactNode; children: ReactNode }) => (
    <div>{actions}{children}</div>
  ),
  Notice: ({ children, testId }: { children: ReactNode; testId?: string }) => (
    <div data-testid={testId}>{children}</div>
  ),
}));

const { default: DeviceInputsStep } = await import('./DeviceInputsStep');

let container: HTMLDivElement;
let root: Root;
const onSaved = vi.fn();

const one = (id: string, key?: string | number) =>
  container.querySelector<HTMLElement>(`[data-testid="${id}"]${key != null ? `[data-test-key="${key}"]` : ''}`);
const type = (id: string, key: string | number, value: string) => {
  const input = one(id, key) as HTMLInputElement;
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const click = (id: string, key?: string | number) => {
  const element = one(id, key) as HTMLButtonElement;
  expect(element).not.toBeNull();
  act(() => element.click());
};

beforeEach(() => {
  api.posts.length = 0;
  onSaved.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<DeviceInputsStep locationId={7025} onSaved={onSaved} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DeviceInputsStep', () => {
  it('shows the overview, each device with its sections and the point no input measures', () => {
    expect(one('device-inputs-overview')).not.toBeNull();
    expect(one('device-inputs-device', 11)?.textContent).toContain('linear');
    expect(one('device-inputs-segment', '12-1')).not.toBeNull();
    expect(one('device-inputs-missing')?.textContent).toContain('1 measure point(s) are measured by no input: 6');
    // Nothing changed yet: nothing to save.
    expect((one('device-inputs-save') as HTMLButtonElement).disabled).toBe(true);
    expect(duplicateTestIds(container)).toEqual([]);
  });

  it('adds a section, then saves which sensor each input measures', () => {
    type('device-inputs-new-from', 12, '3');
    type('device-inputs-new-to', 12, '3');
    type('device-inputs-new-start', 12, '6');
    click('device-inputs-new-add', 12);

    expect(one('device-inputs-missing')).toBeNull();
    expect(one('device-inputs-summary')?.textContent).toContain('all assigned');

    click('device-inputs-save');

    expect(api.posts).toEqual([{
      location_id: 7025,
      devices: [
        { device_id: 11, inputs: [1, 2, 3], edited: [] },
        { device_id: 12, inputs: [4, 5, 6], edited: [3] },
      ],
    }]);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('saves an incomplete assignment only after a warning', () => {
    type('device-inputs-segment-to', '12-1', '1');
    click('device-inputs-segment-apply', '12-1');
    // Sensors 5 and 6 are measured by no input now.
    expect(one('device-inputs-summary')?.textContent).toContain('2 without input');

    click('device-inputs-save');
    expect(api.posts).toEqual([]);
    expect(one('device-inputs-incomplete')?.textContent).toContain('2 measure point(s)');
    click('device-inputs-incomplete-cancel');
    expect(api.posts).toEqual([]);

    click('device-inputs-save');
    click('device-inputs-incomplete-confirm');
    expect(api.posts).toHaveLength(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('frees a section, and blocks saving a sensor on two inputs', () => {
    click('device-inputs-segment-free', '11-1');
    expect(one('device-inputs-device', 11)?.textContent).toContain('not linear');
    expect(one('device-inputs-missing')?.textContent).toContain('1–3, 6');

    type('device-inputs-segment-start', '12-1', '1');
    click('device-inputs-segment-apply', '12-1');
    type('device-inputs-new-from', 11, '1');
    type('device-inputs-new-to', 11, '1');
    type('device-inputs-new-start', 11, '2');
    click('device-inputs-new-add', 11);

    expect(one('device-inputs-doubled')?.textContent).toContain('2');
    expect((one('device-inputs-save') as HTMLButtonElement).disabled).toBe(true);
  });
});
