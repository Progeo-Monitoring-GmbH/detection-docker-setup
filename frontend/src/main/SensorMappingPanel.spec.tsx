// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Ok = (response: unknown) => void;

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: Ok) => ok({ data: api.get(url) }),
    perform_post: (_auth: unknown, url: string, body: unknown, ok: Ok) => ok({ data: api.post(url, body) }),
  },
}));
vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: vi.fn() }) }));

const { default: SensorMappingPanel, asAnswer } = await import('./SensorMappingPanel');

const ANSWER = {
  device_id: 8,
  first_sensor_order: 1,
  sensor_count: 3,
  inputs: [
    { position: 1, sensor_order: 1, source: 'formula' },
    { position: 2, sensor_order: null, source: 'klemmliste' },
    { position: 3, sensor_order: 2, source: 'klemmliste' },
  ],
  versions: [{ id: 4, valid_from: '2026-11-20T10:00:00Z', origin: 'klemmliste', source_name: 'k.pdf',
    mapped: true, inputs: 2, manual: [] }],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // DataTable asks for the colour scheme; jsdom has no matchMedia.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(() => ANSWER);
  api.post.mockImplementation(() => ANSWER);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = async (staff = true) => {
  await act(async () => {
    root.render(
      <SensorMappingPanel auth={{} as never} locationId={7078} devices={[{ id: 8, label: 'smartex dm' }]} staff={staff} />,
    );
  });
};

const byTestId = (id: string, key?: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${id}"]${key ? `[data-test-key="${key}"]` : ''}`);

const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('SensorMappingPanel', () => {
  it('shows which sensor each input measures and where it comes from', async () => {
    await render();

    expect(api.get).toHaveBeenCalledWith('/v1/status/measure_points/sensor_mapping/?location_id=7078&device_id=8');
    expect((byTestId('sensor-mapping-input', '2') as HTMLInputElement).value).toBe('');
    expect((byTestId('sensor-mapping-input', '3') as HTMLInputElement).value).toBe('2');
    expect(byTestId('sensor-mapping-source', '3')!.textContent).toBe('Klemmliste');
    expect(byTestId('sensor-mapping-versions')!.textContent).toContain('k.pdf');
  });

  it('saves only the changed inputs - an empty number is no sensor', async () => {
    await render();
    const save = byTestId('sensor-mapping-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await type(byTestId('sensor-mapping-input', '1') as HTMLInputElement, '');
    await type(byTestId('sensor-mapping-input', '2') as HTMLInputElement, '1x');
    expect((byTestId('sensor-mapping-input', '2') as HTMLInputElement).value).toBe('1');
    await act(async () => save.click());

    expect(api.post).toHaveBeenCalledWith('/v1/status/measure_points/sensor_mapping/', {
      location_id: 7078, device_id: 8, changes: { 1: null, 2: 1 },
    });
  });

  it('goes back to the formula', async () => {
    await render();

    await act(async () => byTestId('sensor-mapping-reset')!.click());

    expect(api.post.mock.calls[0][1]).toEqual({ location_id: 7078, device_id: 8, reset: true });
  });

  it('only shows the numbers to non-staff', async () => {
    await render(false);

    expect(byTestId('sensor-mapping-input', '1')).toBeNull();
    expect(byTestId('sensor-mapping-save')).toBeNull();
  });

  it('reads an unexpected answer as empty', () => {
    expect(asAnswer({ reason: 'x' })).toMatchObject({ inputs: [], versions: [] });
    expect(asAnswer(null)).toBeNull();
  });
});
