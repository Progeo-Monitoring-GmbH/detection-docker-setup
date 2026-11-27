// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hooks = vi.hoisted(() => ({
  snackbar: { enqueueSnackbar: vi.fn() },
  translation: { t: (key: string) => key },
}));
vi.mock('../../axiosConfig', () => ({
  default: { updateToken: () => {}, holder: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } },
}));
vi.mock('notistack', () => ({ useSnackbar: () => hooks.snackbar }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => hooks.translation,
}));

const { default: DeviceConfigPanel } = await import('./DeviceConfigPanel');

let container: HTMLDivElement;
let root: Root;

const resistanceValues = (device: { hardware?: string | null; is_m5?: boolean }) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <MemoryRouter>
        <DeviceConfigPanel
          device={{ id: 4, pull_resistance: 136, data_interval: 300, ...device }}
          canEdit
          locationId={1}
          peSwitched={false}
        />
      </MemoryRouter>,
    ),
  );
  const select = document.body.querySelector<HTMLSelectElement>('[data-testid="device-config-resistance"]');
  return [...(select?.options ?? [])].map((option) => option.value);
};

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the pulldown choices of the config panel', () => {
  it('offer 8 (off) for a Lua box', () => {
    expect(resistanceValues({ hardware: 'smartex mx' })).toContain('8');
  });

  it('leave out 8 (off) for an M5', () => {
    expect(resistanceValues({ hardware: 'M5 AIN4' })).toEqual(['136', '72', '40', '24']);
  });

  it('leave out 8 (off) for a device the overview reports as M5', () => {
    expect(resistanceValues({ is_m5: true })).not.toContain('8');
  });
});
