// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// smartex dm (1) unless a test picks another product.
const LOCATION = { id: 7, project_id: 7078, name: 'Halle 7', project_type: 1 };

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: (response: unknown) => void) => {
      if (url === '/v1/location/min/') {
        ok({ data: [{ ...LOCATION, project_type: product.type }] });
      } else if (url.startsWith('/v1/status/measure_points/')) {
        ok({ data: { points: [], devices: [], lageplans: [] } });
      }
      return Promise.resolve();
    },
    perform_post: () => Promise.resolve(),
  },
}));
const product = vi.hoisted(() => ({ type: 1 }));
// Stable objects, as the real hooks give: the wizard reloads when `auth` changes.
const hooks = vi.hoisted(() => ({
  auth: { user: { is_staff: true } },
  permissions: { hasPermission: () => true, isLoading: false },
}));
vi.mock('../../hooks/CoreAuthProvider', () => ({ useAuth: () => hooks.auth }));
vi.mock('../../hooks/usePermissions', () => ({ default: () => hooks.permissions }));
// The heavy parts of the steps - not what this is about.
vi.mock('../components/ui/ImageCanvasStage.tsx', () => ({ default: () => null }));
vi.mock('../components/device/HeatLimitationStage', () => ({ default: () => null }));
// The dropboxes' props by test id - the points import asks through confirmUpload.
const dropboxes = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('../components/form/CadUploadDropbox.tsx', () => ({
  default: (props: Record<string, unknown>) => {
    dropboxes.set(String(props.testId), props);
    return null;
  },
}));
vi.mock('../components/form/RedDropbox.tsx', () => ({ default: () => null }));
vi.mock('./LageplanKlemmliste', () => ({ default: () => null }));
vi.mock('./LageplanAutoRepair', () => ({ default: () => null }));
vi.mock('./DmTransferStep', () => ({ default: () => null }));

const { default: LageplanWizardView } = await import('./LageplanWizardView');

let container: HTMLDivElement;
let root: Root;
let current = { search: '', hash: '' };

/** Reports the router's URL - the wizard rewrites it. */
const UrlProbe = () => {
  const { search, hash } = useLocation();
  useEffect(() => {
    current = { search, hash };
  }, [search, hash]);
  return null;
};

beforeEach(() => {
  product.type = 1;
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const render = async (url: string) => {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <LageplanWizardView />
        <UrlProbe />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
};

describe('LageplanWizardView anchors', () => {
  it('opens at the step of the #anchor - kept while the location is selected', async () => {
    await render('/site-plan/wizard/?location=7&plan=3#wizard-plans');

    // Selecting the location rewrote ?location/?plan - without losing the anchor.
    expect(current).toEqual({ search: '?location=7', hash: '#wizard-plans' });
    const step = container.querySelector('#wizard-plans')!;
    expect(step.classList.contains('lageplan-step--target')).toBe(true);
    expect(container.querySelectorAll('.lageplan-step--target')).toHaveLength(1);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts[0]).toBe(step);
    // The steps are folded - the one the link points at is unfolded.
    const toggle = (panel: Element) => panel.querySelector('[data-testid="fold-toggle"]')!;
    expect(toggle(step).getAttribute('aria-expanded')).toBe('true');
    const others = [...container.querySelectorAll('section[data-testid^="lageplan-wizard-step-"]')].filter(
      (panel) => panel !== step,
    );
    expect(others.length).toBeGreaterThan(0);
    others.forEach((panel) => expect(toggle(panel).getAttribute('aria-expanded')).toBe('false'));
  });

  it('marks and scrolls to nothing without an anchor', async () => {
    await render('/site-plan/wizard/?location=7');

    expect(current.search).toBe('?location=7');
    expect(container.querySelectorAll('.lageplan-step--target')).toHaveLength(0);
    // Every step folded, each with its explanation.
    const toggles = container.querySelectorAll('[data-testid="fold-toggle"]');
    expect(toggles.length).toBeGreaterThanOrEqual(8);
    toggles.forEach((toggle) => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
    expect(container.querySelector('[data-testid="lageplan-wizard-step-1-hint"]')?.textContent).toBe(
      'lageplan_wizard_hint_location',
    );
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('LageplanWizardView points import', () => {
  it('asks before an import replaces the points - Cancel drops the file, Import sends it', async () => {
    await render('/site-plan/wizard/?location=7');
    const confirmUpload = dropboxes.get('lageplan-wizard-import-cad')?.confirmUpload as (
      files: File[],
      send: () => void,
      cancel: () => void,
    ) => void;
    expect(confirmUpload).toBeTypeOf('function');
    const byTestId = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

    const send = vi.fn();
    const cancel = vi.fn();
    act(() => confirmUpload([new File(['0 0'], 'plan.dxf')], send, cancel));
    expect(byTestId('lageplan-wizard-import-dialog')?.textContent).toContain('lageplan_wizard_import');
    act(() => byTestId('lageplan-wizard-import-dialog-cancel')!.click());
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(byTestId('lageplan-wizard-import-dialog')).toBeNull();

    act(() => confirmUpload([new File(['0 0'], 'plan.dxf')], send, cancel));
    act(() => byTestId('lageplan-wizard-import-dialog-confirm')!.click());
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('LageplanWizardView step 6 by product', () => {
  it('offers smartex dm the dm-Transfer, not the Auto-Repair', async () => {
    await render('/site-plan/wizard/?location=7');

    expect(container.querySelector('#wizard-dm-transfer')).not.toBeNull();
    expect(container.querySelector('#wizard-auto-repair')).toBeNull();
  });

  it('offers point sensors (mx-PEEL) the Auto-Repair, not the dm-Transfer', async () => {
    product.type = 7;
    await render('/site-plan/wizard/?location=7');

    const step = container.querySelector('#wizard-auto-repair')!;
    expect(step).not.toBeNull();
    expect(step.getAttribute('data-testid')).toBe('lageplan-wizard-step-6');
    expect(container.querySelector('#wizard-dm-transfer')).toBeNull();
  });
});
