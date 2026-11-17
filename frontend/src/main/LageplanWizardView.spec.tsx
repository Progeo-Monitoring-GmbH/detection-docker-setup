// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOCATION = { id: 7, project_id: 7078, name: 'Halle 7', project_type: 1 };

vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: (response: unknown) => void) => {
      if (url === '/v1/location/min/') {
        ok({ data: [LOCATION] });
      } else if (url.startsWith('/v1/status/measure_points/')) {
        ok({ data: { points: [], devices: [], lageplans: [] } });
      }
      return Promise.resolve();
    },
    perform_post: () => Promise.resolve(),
  },
}));
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
vi.mock('../components/form/CadUploadDropbox.tsx', () => ({ default: () => null }));
vi.mock('../components/form/RedDropbox.tsx', () => ({ default: () => null }));
vi.mock('./LageplanKlemmliste', () => ({ default: () => null }));

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
    await render('/lageplan/wizard/?location=7&plan=3#wizard-plans');

    // Selecting the location rewrote ?location/?plan - without losing the anchor.
    expect(current).toEqual({ search: '?location=7', hash: '#wizard-plans' });
    const step = container.querySelector('#wizard-plans')!;
    expect(step.classList.contains('lageplan-step--target')).toBe(true);
    expect(container.querySelectorAll('.lageplan-step--target')).toHaveLength(1);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts[0]).toBe(step);
  });

  it('marks and scrolls to nothing without an anchor', async () => {
    await render('/lageplan/wizard/?location=7');

    expect(current.search).toBe('?location=7');
    expect(container.querySelectorAll('.lageplan-step--target')).toHaveLength(0);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});
