import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeasurementCompareRow } from '../components/device/MeasurementSamplesCompareChart.tsx';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import NoiseProfilePanel, { type ProfileRange } from './NoiseProfilePanel';
import NoiseProfileEditor from './NoiseProfileEditor';
import ThresholdMixerToggle from './ThresholdMixerToggle';
import {
  type NoiseProfile,
  noiseMaskOf,
  rateNoiseProfile,
} from './noiseProfiles';
import type { TimeRange } from './timeRanges';
import { referenceSamplesOf, thresholdDataOf } from './analyseNoiseView';
import type { NoiseProfileState } from './useNoiseProfileState';
import useNoiseProfileActions from './useNoiseProfileActions';

type AnalyseNoisePanelProps = {
  locationId: number;
  projectId: number | null | undefined;
  noise: NoiseProfileState;
  shownDeviceName: string | null;
  shownDevice: number | null;
  /** The shown device's loaded (raw) measurements and the heatmap. */
  measurements: MeasurementCompareRow[];
  heatmap: SensorHeatmapResponse | null;
  range: TimeRange;
  frameTime: number | null;
  profileRange: ProfileRange | null;
  onProfileRangeChange: (range: ProfileRange | null) => void;
  alarmThreshold: number | null;
  sensorThresholds: ReadonlyMap<number, number>;
  /** A profile or threshold changed: the heatmap loads again. */
  onChanged: () => void;
};

/**
 * Every profile of the shown device (and the draft) rated for the loaded raw
 * measurements - against the alarm thresholds of their sensors.
 */
const useNoiseRatings = (
  profiles: NoiseProfile[],
  draft: NoiseProfileState['shownDraft'],
  measurements: MeasurementCompareRow[],
  thresholdOf: (pair: number) => number | null,
) => {
  const ratings = useMemo(
    () =>
      new Map(
        profiles.map((profile) => [
          profile.id,
          rateNoiseProfile(measurements, noiseMaskOf(profile), thresholdOf),
        ]),
      ),
    [profiles, measurements, thresholdOf],
  );
  const draftRating = useMemo(
    () =>
      draft
        ? rateNoiseProfile(measurements, noiseMaskOf(draft), thresholdOf)
        : null,
    [draft, measurements, thresholdOf],
  );
  return { ratings, draftRating };
};

/**
 * Staff: the Störungsprofil panel of the Analyse page - the profiles of the
 * shown device, the draft's editor and the thresholds panel. The thresholds
 * panel works on the data loaded here - no request, no period of its own:
 * the heatmap's points and thresholds, the maxima of the shown device's
 * measurements cleaned by the profile being rated (the draft, else the
 * picked or active one), the other devices' from the heatmap.
 */
const AnalyseNoisePanel = ({
  locationId,
  projectId,
  noise,
  shownDeviceName,
  shownDevice,
  measurements,
  heatmap,
  range,
  frameTime,
  profileRange,
  onProfileRangeChange,
  alarmThreshold,
  sensorThresholds,
  onChanged,
}: AnalyseNoisePanelProps) => {
  const { t } = useTranslation();
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(
    null,
  );
  const { deviceProfiles, shownDraft, testedProfile } = noise;
  const actions = useNoiseProfileActions({
    locationId,
    projectId,
    noise,
    shownDevice,
    profileRange,
    onChanged,
    setSelectedProfileId,
  });
  // The picked profile, else the active one.
  const selectedProfile =
    deviceProfiles.find((profile) => profile.id === selectedProfileId) ??
    noise.activeProfile;
  const thresholdOf = useCallback(
    (pair: number) => sensorThresholds.get(pair) ?? alarmThreshold ?? null,
    [sensorThresholds, alarmThreshold],
  );
  const { ratings, draftRating } = useNoiseRatings(
    deviceProfiles,
    shownDraft,
    measurements,
    thresholdOf,
  );
  // The raw measurement of the slider's frame - faint lines in the profile plot.
  const referenceSamples = useMemo(
    () => (shownDraft ? referenceSamplesOf(measurements, frameTime) : null),
    [shownDraft, measurements, frameTime],
  );
  const ratedProfile = shownDraft ?? selectedProfile;
  const thresholdData = useMemo(
    () =>
      heatmap
        ? thresholdDataOf(t, {
            heatmap,
            measurements,
            ratedProfile,
            shownDevice,
            range,
          })
        : null,
    [heatmap, measurements, ratedProfile, shownDevice, range, t],
  );

  return (
    <NoiseProfilePanel
      deviceName={shownDeviceName}
      profiles={deviceProfiles}
      ratings={ratings}
      selectedId={selectedProfile?.id ?? null}
      onSelect={setSelectedProfileId}
      testedId={testedProfile?.id ?? null}
      onTest={noise.setTestedProfileId}
      view={noise.noiseView}
      busy={actions.noiseBusy}
      range={profileRange}
      onClearRange={() => onProfileRangeChange(null)}
      // "Letzte 7 Tage": the span, and its draft right away.
      onPickRange={(span) => {
        onProfileRangeChange(span);
        actions.createNoiseProfile(span);
      }}
      onCreate={() => actions.createNoiseProfile()}
      onEdit={actions.editNoiseProfile}
      onActivate={actions.activateNoiseProfile}
      onDeactivate={actions.deactivateNoiseProfile}
      onDelete={actions.deleteNoiseProfile}
      onDownload={actions.downloadNoiseProfile}
      draftName={shownDraft ? shownDraft.name : null}
      draftRating={draftRating}
      editor={
        shownDraft ? (
          <NoiseProfileEditor
            draft={shownDraft}
            onChange={noise.setDraft}
            onSave={actions.saveNoiseProfile}
            onCancel={() => noise.setDraft(null)}
            saving={actions.noiseBusy}
            preview={noise.draftPreview}
            onPreviewChange={noise.setDraftPreview}
            reference={referenceSamples}
          />
        ) : null
      }
      thresholds={
        <ThresholdMixerToggle
          locationId={locationId}
          initialObjectThreshold={alarmThreshold}
          onSaved={onChanged}
          loaded={thresholdData}
        />
      }
    />
  );
};

export default AnalyseNoisePanel;
