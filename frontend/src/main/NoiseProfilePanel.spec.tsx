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

const render = (props: { range?: { from: number; to: number } | null; selectedId?: number | null } = {}) => {
  const onCreate = vi.fn();
  act(() =>
    root.render(
      <NoiseProfilePanel
        deviceName="smartex dm"
        profiles={[PROFILE]}
        ratings={new Map([[PROFILE.id, RATING]])}
        selectedId={props.selectedId === undefined ? PROFILE.id : props.selectedId}
        onSelect={() => {}}
        testedId={null}
        onTest={() => {}}
        view="none"
        busy={false}
        range={props.range ?? null}
        onClearRange={() => {}}
        onCreate={onCreate}
        onEdit={() => {}}
        onActivate={() => {}}
        onDeactivate={() => {}}
        onDelete={() => {}}
        onDownload={() => {}}
        draftName={null}
        draftRating={null}
        editor={null}
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
});

describe('NoiseProfilePanel', () => {
  it('shows the picked profile\'s rating big, each measure as a traffic light', () => {
    render();
    expect(tile('score').textContent).toContain('72 %');
    expect(tile('score').dataset.level).toBe('good');
    expect(tile('fit').dataset.level).toBe('fair');
    expect(tile('effect').dataset.level).toBe('poor');
  });

  it('has neutral tiles without a picked profile', () => {
    render({ selectedId: null });
    expect(tile('score').dataset.level).toBe('none');
    expect(tile('score').textContent).toContain('–');
  });

  it('makes a new profile only from a selected period - and tells its length', () => {
    let onCreate = render();
    expect(createButton().disabled).toBe(true);

    onCreate = render({ range: { from: 0, to: 4 * HOUR + 30 * 60_000 } });
    expect(container.querySelector('[data-testid="noise-profile-range-length"]')!.textContent).toBe('4 h 30 min');
    act(() => createButton().click());
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
