// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NoiseProfileEditor from './NoiseProfileEditor';
import type { NoiseProfileDraft } from './noiseProfiles';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let latest: NoiseProfileDraft;

const DRAFT: NoiseProfileDraft = {
  id: null,
  device: 1,
  name: 'Profil',
  mask_e: [10, 10, 10, 10],
  mask_w: [50, 50, 50, 50],
  source_from: null,
  source_to: null,
  source_count: 0,
};

/** The editor with the draft kept outside, as the Analyse tab does. */
const Host = () => {
  const [draft, setDraft] = useState(DRAFT);
  latest = draft;
  return (
    <NoiseProfileEditor
      draft={draft}
      onChange={setDraft}
      onSave={() => {}}
      onCancel={() => {}}
      saving={false}
      preview
      onPreviewChange={() => {}}
    />
  );
};

const area = () => container.querySelector<SVGSVGElement>('[data-testid="noise-profile-plot-area"]')!;
const fire = (type: string, x: number, y: number) =>
  act(() => {
    area().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  });
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label))!;
const changes = () => [...container.querySelectorAll('[data-testid="noise-profile-change"]')].map((row) => row.textContent);

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', undefined);
  // jsdom: the plot is 800 px wide at 0/0 - 4 sensors of 200 px (see NoiseProfilePlot.spec).
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800 } as DOMRect);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Host />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NoiseProfileEditor', () => {
  it('lists every manual change next to Speichern, newest first', () => {
    fire('pointerdown', 100, 120); // sensor 1, EP 10 -> 30
    fire('pointerup', 100, 120);
    fire('pointerdown', 300, 65); // sensor 2, near WP
    fire('pointermove', 700, 65); // painted to sensor 4
    fire('pointerup', 700, 65);

    expect(changes()).toEqual([
      '2.WPnoise_profile_change_sensors {"first":2,"last":4,"count":3}Ø 50 → 45',
      '1.EPnoise_profile_change_sensor {"sensor":1}10 → 30',
    ]);
  });

  it('lists nothing for a press that changed no value', () => {
    fire('pointerdown', 100, 193); // EP stays 10
    fire('pointerup', 100, 193);
    expect(changes()).toEqual([]);
    expect(container.textContent).toContain('noise_profile_no_changes');
  });

  it('undoes the last change - button and Strg + Z - and all of them', () => {
    fire('pointerdown', 100, 120); // sensor 1, EP to 30
    fire('pointerup', 100, 120);
    fire('pointerdown', 300, 120); // sensor 2, EP to 30
    fire('pointerup', 300, 120);
    expect(latest.mask_e).toEqual([30, 30, 10, 10]);

    act(() => button('noise_profile_undo').click());
    expect(latest.mask_e).toEqual([30, 10, 10, 10]);
    expect(changes()).toHaveLength(1);

    const plot = container.querySelector<HTMLElement>('[role="group"]')!;
    act(() => {
      plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    });
    expect(latest.mask_e).toEqual([10, 10, 10, 10]);
    expect(changes()).toEqual([]);

    fire('pointerdown', 100, 120);
    fire('pointerup', 100, 120);
    fire('pointerdown', 500, 120);
    fire('pointerup', 500, 120);
    act(() => button('noise_profile_undo_all').click());
    expect(latest.mask_e).toEqual(DRAFT.mask_e);
  });

  it('leaves Strg + Z in the name field to the field', () => {
    fire('pointerdown', 100, 120);
    fire('pointerup', 100, 120);
    const name = container.querySelector<HTMLInputElement>('input.form-control')!;
    act(() => {
      name.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    });
    expect(changes()).toHaveLength(1);
  });
});
