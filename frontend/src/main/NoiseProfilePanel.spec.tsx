// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NoiseProfilePanel from './NoiseProfilePanel';
import type { NoiseProfile, NoiseRating } from './noiseProfiles';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const PROFILE: NoiseProfile = {
  id: 7,
  device: 1,
  name: 'Ruhe',
  mask_e: [1],
  mask_w: [2],
  sum_e: 1,
  sum_w: 2,
  source_from: null,
  source_to: null,
  source_count: 0,
  is_active: false,
  activated_at: null,
  created: null,
  updated: null,
  created_by: null,
};
const RATING: NoiseRating = { score: 72, fit: 0.8, effect: 0.1, exceedBefore: 5, exceedAfter: 1, measurements: 300 };
const HOUR = 3_600_000;

const panelProps = {
  deviceName: 'smartex dm',
  profiles: [PROFILE],
  ratings: new Map([[PROFILE.id, RATING]]),
  selectedId: PROFILE.id,
  onSelect: () => {},
  testedId: null,
  onTest: () => {},
  view: 'none' as const,
  busy: false,
  range: null,
  onClearRange: () => {},
  onPickRange: () => {},
  onCreate: () => {},
  onEdit: () => {},
  onActivate: () => {},
  onDeactivate: () => {},
  onDelete: () => {},
  onDownload: () => {},
  draftName: null,
  draftRating: null,
  editor: null,
};

const render = (
  props: { range?: { from: number; to: number } | null; selectedId?: number | null; active?: boolean } = {},
) => {
  const onCreate = vi.fn();
  act(() =>
    root.render(
      <NoiseProfilePanel
        {...panelProps}
        profiles={[{ ...PROFILE, is_active: props.active ?? false }]}
        selectedId={props.selectedId === undefined ? PROFILE.id : props.selectedId}
        range={props.range ?? null}
        onCreate={onCreate}
      />,
    ),
  );
  return onCreate;
};
const tile = (measure: string) => container.querySelector<HTMLElement>(`[data-testid="noise-rating-${measure}"]`)!;
const createButton = () =>
  [...container.querySelectorAll('button')].find((button) => button.textContent === 'noise_profile_new')!;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('NoiseProfilePanel', () => {
  it('shows the picked profile\'s rating big, each measure as a traffic light', () => {
    render();
    expect(tile('score').textContent).toContain('72 %');
    expect(tile('score').dataset.level).toBe('good');
    expect(tile('fit').dataset.level).toBe('fair');
    expect(tile('effect').dataset.level).toBe('poor');
  });

  it('shows no rating without a picked or active profile', () => {
    render({ selectedId: null });
    expect(container.querySelector('[data-testid="noise-profile-rating"]')).toBeNull();
  });

  it('rates the active profile while none is picked', () => {
    render({ selectedId: null, active: true });
    expect(tile('score').textContent).toContain('72 %');
  });

  it('makes a new profile only from a selected period - and tells its length', () => {
    let onCreate = render();
    expect(createButton().disabled).toBe(true);

    onCreate = render({ range: { from: 0, to: 4 * HOUR + 30 * 60_000 } });
    expect(container.querySelector('[data-testid="noise-profile-range-length"]')!.textContent).toBe('4 h 30 min');
    act(() => createButton().click());
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('picks the last 7 / 30 days up to now as the span - and marks the picked one', () => {
    const now = Date.UTC(2026, 10, 6, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const picked: { from: number; to: number }[] = [];
    act(() =>
      root.render(
        <NoiseProfilePanel
          {...panelProps}
          range={{ from: now - 30 * 24 * HOUR, to: now }}
          onPickRange={(range) => picked.push(range)}
        />,
      ),
    );
    const quick = (days: number) => container.querySelector<HTMLButtonElement>(`[data-testid="noise-profile-range-last-${days}"]`)!;

    expect(quick(30).getAttribute('aria-pressed')).toBe('true');
    expect(quick(7).getAttribute('aria-pressed')).toBe('false');
    act(() => quick(7).click());
    expect(picked).toEqual([{ from: now - 7 * 24 * HOUR, to: now }]);
  });
});
