/**
 * /analyse: the usage help of the frame picker - the page's keys (the
 * profile plot lists its own) and the tips useful in its current state -
 * and the frames of its one slider.
 */
import type { TFunction } from 'i18next';
import type { MeasurementCompareRow } from '../components/device/MeasurementSamplesCompareChart.tsx';
import type { KeyHint } from '../components/ui/KeyHints';
import { parseTimestamp } from './alarmUtils';
import type { NoiseViewState } from './NoiseProfilePanel';

type Translate = TFunction;

/** The keys of the whole page: the frames, the plans (1-9 while there are
 * several) and, for staff, the span of a new profile. */
export const pageKeyHintsOf = (
  t: Translate,
  {
    planHotkeys,
    planCount,
    offerNoiseProfiles,
  }: { planHotkeys: boolean; planCount: number; offerNoiseProfiles: boolean },
): KeyHint[] => [
  { id: 'play', keys: [t('key_space')], label: t('key_hint_play') },
  { id: 'frame-step', keys: ['← / →'], label: t('key_hint_frame_step') },
  { id: 'frame-jump', keys: ['↑ / ↓'], label: t('key_hint_frame_jump') },
  ...(planHotkeys
    ? [
        {
          id: 'plan',
          keys: [`1 … ${Math.min(planCount, 9)}`],
          label: t('key_hint_plan'),
        },
      ]
    : []),
  ...(offerNoiseProfiles
    ? [
        {
          id: 'range-select',
          keys: ['S', t('key_drag')],
          label: t('key_hint_range_select'),
        },
        { id: 'range-clear', keys: ['C'], label: t('key_hint_range_clear') },
      ]
    : []),
  { keys: [t('key_ctrl'), t('key_wheel')], label: t('key_hint_zoom') },
];

/** Staff: the next step with the profiles - edit the draft, make one of the
 * picked span, or pick one - and which profile is active. */
const noiseTipsOf = (
  t: Translate,
  hasDraft: boolean,
  hasRange: boolean,
  activeName: string | null,
): string[] => {
  const step = hasDraft
    ? 'usage_tip_draft'
    : hasRange
      ? 'usage_tip_range_selected'
      : 'usage_tip_range_pick';
  return [
    t(step),
    ...(activeName != null
      ? [t('usage_tip_active', { name: activeName })]
      : []),
  ];
};

/** The usage help's tips: what is useful in the page's current state. */
export const pageTipsOf = (
  t: Translate,
  {
    offerNoiseProfiles,
    hasDraft,
    hasRange,
    noiseView,
    activeName,
  }: {
    offerNoiseProfiles: boolean;
    hasDraft: boolean;
    hasRange: boolean;
    noiseView: NoiseViewState;
    /** The active profile's name; null: none. */
    activeName: string | null;
  },
): string[] => [
  ...(offerNoiseProfiles
    ? noiseTipsOf(
        t,
        hasDraft,
        hasRange,
        noiseView === 'active' ? activeName : null,
      )
    : []),
  t('usage_tip_frames'),
];

/** The measurements' times (epoch s), oldest first. */
export const chartFramesOf = (
  measurements: readonly MeasurementCompareRow[],
): number[] =>
  measurements
    .flatMap((row) => {
      const ms = parseTimestamp(row.last_fetched);
      return ms == null ? [] : [ms / 1000];
    })
    .sort((a, b) => a - b);

/** The slider's frames: the heatmap's - without one the charts'. */
export const frameSecondsOf = (
  heatmapFrames: number[],
  chartFrames: number[],
): number[] => (heatmapFrames.length ? heatmapFrames : chartFrames);
