// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ get: vi.fn() }));
const hooks = vi.hoisted(() => ({ auth: { user: { is_staff: true } } as { user: Record<string, boolean> } }));

vi.mock('../../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string, ok: (response: unknown) => void) => {
      api.get(url);
      const ids = new URL(url, 'http://x').searchParams.get('ids')!.split(',');
      // Odd ids: notifications off; 4: marked purgeable; 9: unknown.
      const flags = Object.fromEntries(
        ids
          .filter((id) => id !== '9')
          .map((id) => [id, { notifications_disabled: Number(id) % 2 === 1, purgeable: id === '4' ? true : null }]),
      );
      ok({ data: { flags } });
    },
  },
}));
vi.mock('../../../hooks/CoreAuthProvider', () => ({ useAuth: () => hooks.auth }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const {
  useLocationFlags,
  setLocationFlags,
  resetLocationFlags,
  isLocationOff,
  LocationFlagIcons,
  ReadinessBadge,
  readinessLevel,
  locationRowClass,
  locationFlagRowStyles,
  seedLocationFlags,
  LOCATION_OFF_CLASS,
  LOCATION_PURGEABLE_CLASS,
} = await import('./locationFlags');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetLocationFlags();
  api.get.mockClear();
  hooks.auth = { user: { is_staff: true } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const Probe = ({ ids, name }: { ids: number[]; name: string }) => {
  const { flagsOf, isOff } = useLocationFlags(ids);
  return (
    <div data-testid={name}>
      {ids.map((id) => (
        <span key={id} data-id={id} data-off={String(isOff(id))}>
          <LocationFlagIcons flags={flagsOf(id)} testKey={id} />
        </span>
      ))}
    </div>
  );
};

const offOf = (name: string) =>
  Object.fromEntries(
    [...container.querySelectorAll(`[data-testid="${name}"] [data-id]`)].map((el) => [
      el.getAttribute('data-id'),
      el.getAttribute('data-off'),
    ]),
  );

const render = async (ui: React.ReactNode) => {
  await act(async () => {
    root.render(ui);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('useLocationFlags', () => {
  it('loads the flags of every table of a page in one request, once per id', async () => {
    await render(
      <>
        <Probe ids={[1, 2, 4]} name="a" />
        <Probe ids={[2, 3, 9]} name="b" />
      </>,
    );

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get.mock.calls[0][0]).toBe('/v1/location/flags/?ids=1,2,4,3,9');
    expect(offOf('a')).toEqual({ 1: 'true', 2: 'false', 4: 'true' });
    expect(offOf('b')).toEqual({ 2: 'false', 3: 'true', 9: 'false' });

    await render(<Probe ids={[1, 2]} name="a" />);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('follows a toggle in every table at once', async () => {
    await render(
      <>
        <Probe ids={[2]} name="a" />
        <Probe ids={[2]} name="b" />
      </>,
    );
    expect(offOf('a')[2]).toBe('false');

    await act(async () => setLocationFlags(2, { purgeable: true }));

    expect(offOf('a')[2]).toBe('true');
    expect(offOf('b')[2]).toBe('true');
    expect(container.querySelector('[aria-label="location_flag_purgeable"]')).not.toBeNull();
  });

  it('shows the readiness score as a badge next to the name, also for a location switched on', async () => {
    await render(<Probe ids={[2]} name="a" />);
    expect(container.querySelector('[data-testid="readiness-badge"]')).toBeNull();

    await act(async () => setLocationFlags(2, { readiness_score: 85 }));

    const badge = container.querySelector('[data-testid="readiness-badge"]')!;
    expect(badge.textContent).toBe('85');
    expect(badge.className).toContain('readiness-badge--almost');
    // No router in this test: a plain badge, no link.
    expect(badge.tagName).toBe('SPAN');
    expect(offOf('a')[2]).toBe('false');
  });

  it('shows nothing and asks nothing for non-staff users', async () => {
    hooks.auth = { user: {} };
    await render(<Probe ids={[1, 4]} name="a" />);

    expect(api.get).not.toHaveBeenCalled();
    expect(offOf('a')).toEqual({ 1: 'false', 4: 'false' });
    expect(container.querySelector('[data-testid="location-flag-icons"]')).toBeNull();
  });
});

describe('readinessLevel', () => {
  it('matches the backend levels', () => {
    expect([100, 99, 80, 79, 50, 49, 0].map(readinessLevel)).toEqual([
      'ready', 'almost', 'almost', 'progress', 'progress', 'open', 'open',
    ]);
  });
});

describe('ReadinessBadge', () => {
  it('links to the checklist inside a router', async () => {
    const { MemoryRouter } = await import('react-router');
    await render(
      <MemoryRouter>
        <ReadinessBadge score={42} locationId={7} testKey="x" />
      </MemoryRouter>,
    );

    const badge = container.querySelector('[data-testid="readiness-badge"]')!;
    expect(badge.getAttribute('href')).toBe('/checklist/location/?location=7');
    expect(badge.className).toContain('readiness-badge--open');
  });
});

describe('isLocationOff', () => {
  it('is off with notifications disabled or a purge mark, not when unknown', () => {
    expect(isLocationOff({ notifications_disabled: true, purgeable: null })).toBe(true);
    expect(isLocationOff({ notifications_disabled: false, purgeable: true })).toBe(true);
    expect(isLocationOff({ notifications_disabled: false, purgeable: false })).toBe(false);
    expect(isLocationOff(null)).toBe(false);
  });
});

describe('locationRowClass', () => {
  it('stripes purgeable rows red, other switched-off rows grey, the rest not at all', () => {
    expect(locationRowClass({ notifications_disabled: true, purgeable: true })).toBe(LOCATION_PURGEABLE_CLASS);
    expect(locationRowClass({ notifications_disabled: false, purgeable: true })).toBe(LOCATION_PURGEABLE_CLASS);
    expect(locationRowClass({ notifications_disabled: true, purgeable: null })).toBe(LOCATION_OFF_CLASS);
    expect(locationRowClass({ notifications_disabled: false, purgeable: false })).toBe('');
    expect(locationRowClass(null)).toBe('');
  });

  it('gives the data table two exclusive rules', () => {
    const flags: Record<number, { notifications_disabled: boolean; purgeable: boolean | null }> = {
      1: { notifications_disabled: true, purgeable: true },
      2: { notifications_disabled: true, purgeable: null },
      3: { notifications_disabled: false, purgeable: null },
    };
    const [purgeable, off] = locationFlagRowStyles((row: { id: number }) => flags[row.id] ?? null);
    expect(purgeable.classNames).toEqual([LOCATION_PURGEABLE_CLASS]);
    expect(off.classNames).toEqual([LOCATION_OFF_CLASS]);
    expect([1, 2, 3].map((id) => [purgeable.when({ id }), off.when({ id })])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
  });
});

describe('seedLocationFlags', () => {
  it('stores flags that came with the rows - no request for them', async () => {
    seedLocationFlags([
      { id: 5, notifications_disabled: false, purgeable: true, readiness_score: 80 },
      { id: 6, notifications_disabled: true, purgeable: null },
    ]);
    await render(<Probe ids={[5, 6]} name="a" />);

    expect(api.get).not.toHaveBeenCalled();
    expect(offOf('a')).toEqual({ 5: 'true', 6: 'true' });
    expect(container.querySelector('[data-testid="readiness-badge"]')?.textContent).toBe('80');
  });

  it('keeps a value toggled on the page', async () => {
    setLocationFlags(5, { notifications_disabled: false, purgeable: false });
    seedLocationFlags([{ id: 5, notifications_disabled: false, purgeable: true }]);
    await render(<Probe ids={[5]} name="a" />);

    expect(offOf('a')).toEqual({ 5: 'false' });
  });
});
