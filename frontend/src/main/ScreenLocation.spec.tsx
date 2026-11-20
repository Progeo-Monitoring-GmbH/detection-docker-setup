// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenFailure, ScreenImage } from './screenReview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// t(): the key with the values it was given - "screens_step_click(staff-users-add)".
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const shown = ['target', 'value', 'name', 'count']
        .filter((name) => values?.[name] != null && values[name] !== '')
        .map((name) => String(values?.[name]));
      return shown.length ? `${key}(${shown.join('|')})` : key;
    },
  }),
}));

const { default: ScreenLocation, ScreenFailures } = await import('./ScreenLocation');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const page: ScreenImage = {
  file: 'pc-staff-de-device-overview.png',
  device: 'pc',
  role: 'staff',
  language: 'de',
  action: 'device-overview',
  path: '/device/overview?location=1',
  url: '/device/overview?location=1',
  modal: null,
  viewport: [1440, 900],
  width: 1440,
  height: 1800,
  errors: [],
};

const dialog: ScreenImage = {
  ...page,
  file: 'mobile-staff-de-device-overview--device-commands.png',
  device: 'mobile',
  modal: {
    name: 'device-commands',
    testId: 'device-commands',
    path: '/device/overview?location=1',
    scenario: null,
    steps: [
      { do: 'click', css: '#row-1 [data-testid^="expander-button-"]', device: 'mobile' },
      { do: 'click', testId: 'device-list-commands', key: '1' },
    ],
  },
};

const render = (node: React.ReactNode) => act(() => root.render(<div>{node}</div>));
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('ScreenLocation', () => {
  it("links the screenshot's URL into the portal, in a new tab", () => {
    render(<ScreenLocation image={page} />);

    const link = byTestId('screen-url') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/device/overview?location=1');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(link.dataset.testKey).toBe(page.file);
    // A page shows no dialog.
    expect(byTestId('screen-modal')).toBeNull();
  });

  it('falls back to the path on runs without urls', () => {
    render(<ScreenLocation image={{ ...page, url: undefined, path: '/location/overview/' }} />);

    expect(byTestId('screen-url')?.getAttribute('href')).toBe('/location/overview/');
  });

  it('shows no link for an address outside the portal', () => {
    render(<ScreenLocation image={{ ...page, url: 'javascript:alert(1)' }} />);

    expect(byTestId('screen-url')).toBeNull();
    expect(container.textContent).toContain('javascript:alert(1)');
  });

  it('names the dialog and the steps that open it, in order', () => {
    render(<ScreenLocation image={dialog} />);

    expect(byTestId('screen-modal')?.textContent).toBe('screens_dialog: device-commands');
    const steps = [...container.querySelectorAll('.screen-location-step')].map((step) => step.textContent);
    expect(steps).toEqual([
      'screens_step_click(#row-1 [data-testid^="expander-button-"])',
      'screens_step_click(device-list-commands [1])',
    ]);
    expect(byTestId('screen-modal-steps')?.textContent).toContain('[data-testid="device-commands"]');
  });

  it("leaves out the phone's steps on a pc screenshot", () => {
    render(<ScreenLocation image={{ ...dialog, device: 'pc' }} />);

    const steps = [...container.querySelectorAll('.screen-location-step')].map((step) => step.textContent);
    expect(steps).toEqual(['screens_step_click(device-list-commands [1])']);
  });
});

describe('ScreenFailures', () => {
  const failure: ScreenFailure = {
    file: 'pc-staff-de-staff-admin--staff-user-delete-dialog.png',
    device: 'pc',
    role: 'staff',
    language: 'de',
    action: 'staff-admin',
    url: '/staff/',
    modal: {
      name: 'staff-user-delete-dialog',
      testId: 'staff-user-delete-dialog',
      path: '/staff/',
      scenario: null,
      steps: [{ do: 'click', testId: 'staff-user-delete', key: '2' }],
    },
    reason: 'step 1 (click [data-testid="staff-user-delete"]): Timeout 8000ms exceeded.',
  };

  it('lists the dialogs that did not open, with where and why', () => {
    render(<ScreenFailures failures={[failure]} />);

    expect(byTestId('screens-failures')?.querySelector('summary')?.textContent).toContain('screens_failures(1)');
    const entry = byTestId('screens-failure');
    expect(entry?.dataset.testKey).toBe(failure.file);
    expect(entry?.textContent).toContain('staff-admin › staff-user-delete-dialog');
    expect(entry?.textContent).toContain('Timeout 8000ms exceeded.');
    expect(entry?.querySelector('a')?.getAttribute('href')).toBe('/staff/');
  });

  it('shows nothing without failures', () => {
    render(<ScreenFailures failures={[]} />);

    expect(byTestId('screens-failures')).toBeNull();
  });
});
