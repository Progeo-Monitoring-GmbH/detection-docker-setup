/**
 * /analyse, staff: what the Störungsprofile (noiseProfiles.ts) do to the
 * shown values. Staff load the measurements raw and clean them here - by
 * the active profile, the one tried out ("Anwenden") or the draft being
 * edited; the heatmap is cleaned by the backend.
 */
import type { TFunction } from 'i18next';
import type { MeasurementCompareRow } from '../components/device/MeasurementSamplesCompareChart.tsx';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import { mixerSensorsFromLoaded } from './thresholdMixer';
import { timeRangeLabelKey, type TimeRange } from './timeRanges';
import type { NoiseViewState } from './NoiseProfilePanel';
import { parseTimestamp } from './alarmUtils';
import {
  cleanRows,
  type NoiseMask,
  noiseMaskOf,
  type NoiseProfile,
  type NoiseProfileDraft,
} from './noiseProfiles';

type NoiseViewProfiles = {
  /** The draft of the shown device (null: none). */
  shownDraft: NoiseProfileDraft | null;
  /** The draft cleans the values - else they are raw, its masks as lines. */
  draftPreview: boolean;
  testedProfile: NoiseProfile | null;
  activeProfile: NoiseProfile | null;
};

/** The loaded profiles of the shown device - none while they are of
 * another location. */
export const deviceProfilesOf = (
  load: { locationId: unknown; profiles: NoiseProfile[] } | null,
  locationId: unknown,
  shownDevice: number | null,
): NoiseProfile[] =>
  load && load.locationId === locationId
    ? load.profiles.filter((profile) => profile.device === shownDevice)
    : [];

/** Of the shown device's profiles: the active one, the one tried out and
 * the draft - each null when there is none (or it is another device's). */
export const shownProfilesOf = (
  deviceProfiles: readonly NoiseProfile[],
  testedProfileId: number | null,
  draft: NoiseProfileDraft | null,
  shownDevice: number | null,
) => ({
  activeProfile: deviceProfiles.find((profile) => profile.is_active) ?? null,
  testedProfile:
    deviceProfiles.find((profile) => profile.id === testedProfileId) ?? null,
  shownDraft: draft && draft.device === shownDevice ? draft : null,
});

/** What the values are cleaned with: the draft, else the tried-out
 * profile, else the active one. */
export const noiseViewOf = ({
  shownDraft,
  draftPreview,
  testedProfile,
  activeProfile,
}: NoiseViewProfiles): NoiseViewState => {
  if (shownDraft) {
    return draftPreview ? 'draft' : 'raw';
  }
  if (testedProfile) {
    return 'test';
  }
  return activeProfile ? 'active' : 'none';
};

/** The mask the measurements are cleaned with here (staff load them raw). */
export const displayMaskOf = (
  offer: boolean,
  view: NoiseViewState,
  { shownDraft, testedProfile, activeProfile }: NoiseViewProfiles,
): NoiseMask | null => {
  if (!offer) {
    return null;
  }
  if (view === 'draft') {
    return noiseMaskOf(shownDraft);
  }
  if (view === 'test') {
    return noiseMaskOf(testedProfile);
  }
  return view === 'active' ? noiseMaskOf(activeProfile) : null;
};

/** The draft without its preview: the raw values with its masks as lines. */
export const maskLinesOf = (
  offer: boolean,
  view: NoiseViewState,
  shownDraft: NoiseProfileDraft | null,
) =>
  offer && view === 'raw' && shownDraft
    ? { ep: shownDraft.mask_e, wp: shownDraft.mask_w }
    : null;

/** The heatmap is cleaned by the backend: the raw values, the tried-out
 * profile, else (also for a draft - not saved yet) the active ones. */
export const heatNoiseQueryOf = (
  offer: boolean,
  view: NoiseViewState,
  testedProfile: NoiseProfile | null,
) => {
  if (!offer) {
    return '';
  }
  if (view === 'raw') {
    return '&raw=1';
  }
  return view === 'test' && testedProfile
    ? `&noise_profile=${testedProfile.id}`
    : '';
};

/**
 * The raw measurement of the slider's frame - faint lines in the profile
 * plot: the one nearest to the frame, no frame picked: the newest one.
 * null without measurements.
 */
export const referenceSamplesOf = (
  measurements: readonly MeasurementCompareRow[],
  frameTime: number | null,
): { ep: number[]; wp: number[] } | null => {
  if (!measurements.length) {
    return null;
  }
  const rank = (ms: number) =>
    frameTime == null ? -ms : Math.abs(ms - frameTime);
  let samples: number[] = [];
  let best = Number.POSITIVE_INFINITY;
  for (const row of measurements) {
    const ms = parseTimestamp(row.last_fetched);
    if (ms != null && Array.isArray(row.samples) && rank(ms) < best) {
      samples = row.samples;
      best = rank(ms);
    }
  }
  return {
    ep: samples.filter((_, index) => index % 2 === 0).map(Number),
    wp: samples.filter((_, index) => index % 2 === 1).map(Number),
  };
};

export type NoiseBadge = {
  text: string;
  hint: string;
  color: string;
  background: string;
};

type Translate = TFunction;

/** Staff: which Störungsprofil the shown values are cleaned with - a badge
 * in the frame picker; null: none (raw, or no profile). */
export const noiseBadgeOf = (
  t: Translate,
  view: NoiseViewState,
  activeProfile: NoiseProfile | null,
  testedProfile: NoiseProfile | null,
): NoiseBadge | null => {
  if (view === 'active' && activeProfile) {
    return {
      text: t('noise_badge_active', { name: activeProfile.name }),
      hint: t('noise_badge_active_hint', { name: activeProfile.name }),
      color: '#1e7b34',
      background: 'rgba(141, 193, 96, 0.2)',
    };
  }
  if (view === 'test' && testedProfile) {
    return {
      text: t('noise_badge_test', { name: testedProfile.name }),
      hint: t('noise_badge_test_hint'),
      color: '#8a5a00',
      background: 'rgba(251, 188, 21, 0.25)',
    };
  }
  if (view === 'draft') {
    return {
      text: t('noise_badge_draft'),
      hint: t('noise_badge_draft_hint'),
      color: '#a3401f',
      background: 'rgba(235, 99, 59, 0.15)',
    };
  }
  return null;
};

/**
 * The thresholds panel's sensors from the data loaded on the page - the
 * heatmap's points and thresholds (its values only for |WP - EP|), the
 * maxima of the shown device's measurements cleaned by the rated profile
 * (the draft, else the picked or active one) - and a note what they are.
 */
export const thresholdDataOf = (
  t: Translate,
  {
    heatmap,
    measurements,
    ratedProfile,
    shownDevice,
    range,
  }: {
    heatmap: SensorHeatmapResponse;
    measurements: MeasurementCompareRow[];
    ratedProfile: NoiseProfile | NoiseProfileDraft | null;
    shownDevice: number | null;
    range: TimeRange;
  },
) => ({
  sensors: mixerSensorsFromLoaded({
    points: heatmap.sensor_points ?? [],
    heatData:
      !heatmap.profile || heatmap.profile === 'diff' ? heatmap.data : null,
    rows: cleanRows(measurements, noiseMaskOf(ratedProfile)),
    shownDevice,
  }),
  note: t(
    ratedProfile ? 'thresholds_source_profile' : 'thresholds_source_raw',
    {
      name: ratedProfile?.name ?? '',
      period: t(timeRangeLabelKey(range)),
      count: measurements.length,
    },
  ),
});
