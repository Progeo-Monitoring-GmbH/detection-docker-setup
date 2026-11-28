// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceKind } from '../../main/locationTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The media queries that match (coarse pointer, reduced motion). */
const media = vi.hoisted(() => ({ matching: new Set<string>() }));
window.matchMedia = (query: string) =>
  ({
    matches: media.matching.has(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const {
  default: DeviceKindTabs,
  useDeviceKindTab,
} = await import('./DeviceKindTabs');
const { HINT_STORAGE_KEY, PRELOAD_FALLBACK_MS } = await import('./deviceKindTabsLogic');

type Ctx = { visible: boolean; onReady: () => void; loadKey: string };

/** What each panel got last, and its onReady. */
let seen: Partial<Record<DeviceKind, Ctx>>;
const selected = vi.fn();

let container: HTMLDivElement;
let root: Root;

const panel = (kind: DeviceKind, ctx: Ctx): ReactNode => {
  seen[kind] = ctx;
  return (
    <div data-testid={`content-${kind}`} data-key={ctx.loadKey}>
      <input type="range" data-testid={`slider-${kind}`} />
      <div data-no-swipe data-testid={`plan-${kind}`} />
      <div className="own-drag" data-testid={`drag-${kind}`}>
        <span data-testid={`drag-child-${kind}`} />
      </div>
    </div>
  );
};

const Tabs = ({
  kinds,
  active,
  loadKey = '7d',
}: {
  kinds: readonly DeviceKind[];
  active: DeviceKind;
  loadKey?: string;
}) => (
  <DeviceKindTabs
    kinds={kinds}
    active={active}
    onSelect={selected}
    loadKey={loadKey}
    renderPanel={panel}
    testId="status-tabs"
  />
);

const BOTH: readonly DeviceKind[] = ['leak', 'climate'];

const render = (node: ReactNode) =>
  act(() => root.render(<MemoryRouter>{node}</MemoryRouter>));
const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

const touch = (element: Element, type: 'touchstart' | 'touchend', x: number, y: number) => {
  const event = new Event(type, { bubbles: true }) as Event & {
    touches: unknown[];
    changedTouches: unknown[];
  };
  const point = { clientX: x, clientY: y };
  event.touches = type === 'touchstart' ? [point] : [];
  event.changedTouches = [point];
  act(() => {
    element.dispatchEvent(event);
  });
};
const swipe = (element: Element, dx: number, dy = 0) => {
  touch(element, 'touchstart', 200, 300);
  touch(element, 'touchend', 200 + dx, 300 + dy);
};

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  seen = {};
  selected.mockClear();
  media.matching = new Set();
  localStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DeviceKindTabs', () => {
  it('one kind: just its panel, visible - no tabs', () => {
    render(<Tabs kinds={['leak']} active="leak" />);
    expect(container.querySelector('.nav')).toBeNull();
    expect(byTestId('content-leak')).not.toBeNull();
    expect(seen.leak?.visible).toBe(true);
  });

  it('two kinds: the active panel first, the other one once it is ready - hidden', () => {
    render(<Tabs kinds={BOTH} active="leak" />);
    expect(byTestId('status-tabs-tab-leak')).not.toBeNull();
    expect(byTestId('status-tabs-tab-climate')).not.toBeNull();
    expect(byTestId('content-climate')).toBeNull();

    act(() => seen.leak?.onReady());
    expect(byTestId('content-climate')).not.toBeNull();
    expect(byTestId('status-tabs-panel-climate')?.hidden).toBe(true);
    expect(byTestId('status-tabs-panel-leak')?.hidden).toBe(false);
    expect(seen.climate?.visible).toBe(false);
  });

  it('preloads anyway after the fallback time', () => {
    render(<Tabs kinds={BOTH} active="leak" />);
    wait(PRELOAD_FALLBACK_MS - 1);
    expect(byTestId('content-climate')).toBeNull();
    wait(1);
    expect(byTestId('content-climate')).not.toBeNull();
  });

  it('a click selects the tab; the newly shown panel resizes its charts', () => {
    const resized = vi.fn();
    window.addEventListener('resize', resized);
    render(<Tabs kinds={BOTH} active="leak" />);
    act(() => byTestId('status-tabs-tab-climate')?.click());
    expect(selected).toHaveBeenCalledWith('climate');

    render(<Tabs kinds={BOTH} active="climate" />);
    expect(byTestId('status-tabs-panel-climate')?.hidden).toBe(false);
    expect(byTestId('status-tabs-panel-leak')?.hidden).toBe(true);
    expect(resized).toHaveBeenCalled();
    window.removeEventListener('resize', resized);
  });

  it('a hidden panel gets a new load key only once the visible one is ready for it', () => {
    render(<Tabs kinds={BOTH} active="leak" loadKey="7d" />);
    act(() => seen.leak?.onReady());
    expect(seen.climate?.loadKey).toBe('7d');

    render(<Tabs kinds={BOTH} active="leak" loadKey="30d" />);
    expect(seen.leak?.loadKey).toBe('30d');
    expect(seen.climate?.loadKey).toBe('7d');

    act(() => seen.leak?.onReady());
    expect(seen.climate?.loadKey).toBe('30d');
  });

  it('a hidden panel gets the new load key after the fallback time, too', () => {
    render(<Tabs kinds={BOTH} active="leak" loadKey="7d" />);
    act(() => seen.leak?.onReady());
    render(<Tabs kinds={BOTH} active="leak" loadKey="30d" />);
    wait(PRELOAD_FALLBACK_MS);
    expect(seen.climate?.loadKey).toBe('30d');
  });
});

describe('DeviceKindTabs - touch', () => {
  it('a swipe over the content switches - on touch devices only', () => {
    render(<Tabs kinds={BOTH} active="leak" />);
    swipe(byTestId('content-leak')!, -80);
    expect(selected).not.toHaveBeenCalled();

    media.matching = new Set(['(pointer: coarse)']);
    render(<Tabs kinds={BOTH} active="leak" />);
    swipe(byTestId('content-leak')!, -80);
    expect(selected).toHaveBeenCalledWith('climate');
  });

  it('no swipe from elements that need horizontal gestures themselves', () => {
    media.matching = new Set(['(pointer: coarse)']);
    render(<Tabs kinds={BOTH} active="leak" />);
    swipe(byTestId('plan-leak')!, -80);
    swipe(byTestId('slider-leak')!, -80);
    expect(selected).not.toHaveBeenCalled();
  });

  it('no swipe from elements that take their own one-finger drags (touch-action: none)', () => {
    const style = document.createElement('style');
    style.textContent = '.own-drag { touch-action: none; }';
    document.head.appendChild(style);
    media.matching = new Set(['(pointer: coarse)']);
    render(<Tabs kinds={BOTH} active="leak" />);
    swipe(byTestId('drag-child-leak')!, -80);
    expect(selected).not.toHaveBeenCalled();
    swipe(byTestId('content-leak')!, -80);
    expect(selected).toHaveBeenCalledWith('climate');
    style.remove();
  });

  it('the other tab pulses on touch devices until the first switch', () => {
    render(<Tabs kinds={BOTH} active="leak" />);
    expect(byTestId('status-tabs-tab-climate')?.className).not.toMatch(/device-kind-tab--pulse/);

    media.matching = new Set(['(pointer: coarse)']);
    render(<Tabs kinds={BOTH} active="leak" />);
    expect(byTestId('status-tabs-tab-climate')?.className).toMatch(/device-kind-tab--pulse/);
    expect(byTestId('status-tabs-tab-leak')?.className).not.toMatch(/device-kind-tab--pulse/);

    act(() => byTestId('status-tabs-tab-climate')?.click());
    expect(localStorage.getItem(HINT_STORAGE_KEY)).toBe('1');
    render(<Tabs kinds={BOTH} active="climate" />);
    expect(container.querySelector('.device-kind-tab--pulse')).toBeNull();
  });

  it('no pulse once switched before (this browser)', () => {
    localStorage.setItem(HINT_STORAGE_KEY, '1');
    media.matching = new Set(['(pointer: coarse)']);
    render(<Tabs kinds={BOTH} active="leak" />);
    expect(container.querySelector('.device-kind-tab--pulse')).toBeNull();
  });

  it('reduced motion: an arrow instead of the pulse', () => {
    media.matching = new Set(['(pointer: coarse)', '(prefers-reduced-motion: reduce)']);
    render(<Tabs kinds={BOTH} active="leak" />);
    expect(container.querySelector('.device-kind-tab--pulse')).toBeNull();
    expect(
      byTestId('status-tabs-tab-climate')?.querySelector('[aria-label="status_tab_swipe_hint"]'),
    ).not.toBeNull();
  });

  it('a storage that throws breaks nothing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    media.matching = new Set(['(pointer: coarse)']);
    render(<Tabs kinds={BOTH} active="leak" />);
    act(() => byTestId('status-tabs-tab-climate')?.click());
    expect(selected).toHaveBeenCalledWith('climate');
  });
});

describe('useDeviceKindTab', () => {
  const Probe = ({ kinds }: { kinds: readonly DeviceKind[] }) => {
    const [tab, setTab] = useDeviceKindTab(kinds);
    return (
      <button type="button" data-testid="tab" onClick={() => setTab('climate')}>
        {tab}
      </button>
    );
  };
  // A fresh router per URL (a MemoryRouter keeps its first entries).
  const at = (path: string, kinds: readonly DeviceKind[]) =>
    act(() => {
      root.unmount();
      root = createRoot(container);
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <Probe kinds={kinds} />
        </MemoryRouter>,
      );
    });

  it('reads ?tab= - the first tab without it', () => {
    at('/location/4/status', BOTH);
    expect(byTestId('tab')?.textContent).toBe('leak');
    at('/location/4/status?tab=climate', BOTH);
    expect(byTestId('tab')?.textContent).toBe('climate');
  });

  it('a tab the location does not have opens the first one', () => {
    at('/location/4/status?tab=climate', ['leak']);
    expect(byTestId('tab')?.textContent).toBe('leak');
    at('/location/4/status?tab=wind', BOTH);
    expect(byTestId('tab')?.textContent).toBe('leak');
  });

  it('selecting writes ?tab=', () => {
    at('/location/4/status', BOTH);
    act(() => byTestId('tab')?.click());
    expect(byTestId('tab')?.textContent).toBe('climate');
  });
});
