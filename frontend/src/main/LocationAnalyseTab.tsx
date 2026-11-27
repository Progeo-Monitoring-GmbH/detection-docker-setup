import { useCallback, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { PortalOutletContext } from './LocationPortalLayout';
import type { ProfileRange } from './NoiseProfilePanel';
import { useFullscreen } from '../components/ui/kit/Fullscreen';
import AnalyseActions from './AnalyseActions';
import AnalyseClimateSection from './AnalyseClimateSection';
import AnalyseDeviceSection from './AnalyseDeviceSection';
import AnalyseFrameControl from './AnalyseFrameControl';
import AnalyseNoiseBadge from './AnalyseNoiseBadge';
import { noiseBadgeOf } from './analyseNoiseView';
import { pageKeyHintsOf, pageTipsOf } from './analysePageHelp';
import { sensorThresholdsOf } from './analyseSelection';
import useAnalyseArchive from './useAnalyseArchive';
import useAnalyseCompare from './useAnalyseCompare';
import useAnalyseExports from './useAnalyseExports';
import useAnalyseFrames from './useAnalyseFrames';
import useAnalyseHotkeys from './useAnalyseHotkeys';
import {
  SENSOR_HISTORY_DAYS,
  useAnalyseHeatmap,
  useAnalyseMeasurements,
  useSensorHistory,
} from './useAnalyseLoads';
import { useAnalysePlans } from './useAnalysePlans';
import {
  useAnalyseAccess,
  useAnalysePeriod,
  useLocationChoice,
} from './useAnalyseSettings';
import useAnalyseShown from './useAnalyseShown';
import useNoiseProfileState from './useNoiseProfileState';
import useSensorSelection from './useSensorSelection';
import useSensorSwitch from './useSensorSwitch';
import './LocationAnalyseTab.css';

const MOBILE_WIDTH = 860;

/**
 * Analyse route: the location heatmap plus the measurements of all its
 * devices over the selected period (last 24 h / 7 / 30 days; staff also the
 * last quarter, half year and year) - only periods the data reaches into.
 * Reuses the existing heatmap + measurement endpoints and components; the
 * state lives in the useAnalyse* hooks, smartex io objects get their climate
 * heatmap and charts (AnalyseClimateSection), all others the heatmap and
 * samples (AnalyseDeviceSection).
 */
const LocationAnalyseTab = () => {
  const { location, locationId } = useOutletContext<PortalOutletContext>();
  const { t } = useTranslation();
  const access = useAnalyseAccess(location);
  const { isSmartexIo, isStaff, offerNoiseProfiles, rawQuery } = access;
  const period = useAnalysePeriod(locationId, isStaff);
  const { range, days, resolution, meanWindow, heatProfile } = period;
  // The heatmap on the whole screen (phones: the only way to read it).
  const heatmapFullscreen = useFullscreen();
  // The heatmap card is foldable - its height is the page's largest block.
  const [heatmapOpen, setHeatmapOpen] = useState(true);
  // The measurements' zoomed time span - a band on the slider.
  const [chartZoom, setChartZoom] = useState<{
    from: number;
    to: number;
  } | null>(null);
  // The chart shows one device: the picked one (of this location), else the
  // backend's default - the device that measured last.
  const [deviceId, pickDevice] = useLocationChoice<number>(locationId);
  // Bumped when a profile, threshold or sensor changed: the heatmap reloads.
  const [noiseRevision, setNoiseRevision] = useState(0);
  // The span a new profile is made from - picked with S + drag on the
  // measurements' time plots, moved / resized under the frame slider.
  const [profileRange, setProfileRange] =
    useLocationChoice<ProfileRange>(locationId);
  const clearProfileRange = useCallback(
    () => setProfileRange(null),
    [setProfileRange],
  );

  const { plans, planId, pickPlan, planQuery } = useAnalysePlans(
    location,
    locationId,
  );
  const exports = useAnalyseExports(locationId, location?.project_id);
  const loadOptions = { locationId, enabled: !isSmartexIo, days, resolution };
  const loads = useAnalyseMeasurements({ ...loadOptions, deviceId, rawQuery });
  const { measurements, devices, shownDevice } = loads;
  const noise = useNoiseProfileState({
    locationId,
    offer: offerNoiseProfiles,
    shownDevice,
  });
  const { displayMask, heatNoiseQuery } = noise;
  const heatmapLoad = useAnalyseHeatmap({
    ...loadOptions,
    planQuery,
    heatProfile,
    heatNoiseQuery,
    revision: noiseRevision,
  });
  const { heatmap, clearHeatmapCache } = heatmapLoad;
  const invalidateHeatmap = useCallback(() => {
    clearHeatmapCache();
    setNoiseRevision((revision) => revision + 1);
  }, [clearHeatmapCache]);
  const sensorHistory = useSensorHistory({ locationId, shownDevice, rawQuery });
  const shown = useAnalyseShown({
    heatmap,
    heatmapLoading: heatmapLoad.heatmapLoading,
    planId,
    measurements,
    historyRows: sensorHistory.rows,
    displayMask,
    meanWindow,
  });

  const frames = useAnalyseFrames({ isSmartexIo, heatmap, measurements });
  const { frameTime, setFrameTime, frameSeconds } = frames;

  const comparison = useAnalyseCompare({
    ...loadOptions,
    measurementRange: period.measurementRange,
    heatProfile,
    shownDevice,
    heatNoiseQuery,
    revision: noiseRevision,
    planQuery,
    rawQuery,
    displayMask,
    meanWindow,
    shownHeatmap: shown.shownHeatmap,
  });

  // The plan's sensors and the measurements' second plot (analyseSelection).
  const points = useMemo(() => heatmap?.sensor_points ?? [], [heatmap]);
  const selection = useSensorSelection({
    points,
    shownDevice,
    deviceIds: devices.map((device) => device.id),
    onDevice: pickDevice,
  });
  // The alarm thresholds on the first measurement plot: the location's, and
  // the own ones of the shown device's sensors (pair index).
  const alarmThreshold =
    heatmap?.location?.alarm_threshold ?? location?.alarm_threshold ?? null;
  const sensorThresholds = useMemo(
    () => sensorThresholdsOf(points, shownDevice),
    [points, shownDevice],
  );
  const sensorSwitch = useSensorSwitch({
    locationId,
    points,
    shownDevice,
    deviceCount: devices.length,
    sensors: selection.sensors,
    onSwitched: invalidateHeatmap,
  });
  const archive = useAnalyseArchive({
    locationId,
    profileRange,
    shownDevice,
    // Load everything again - staff who hide archived ones no longer see them.
    onArchived: () => {
      clearHeatmapCache();
      loads.clearMeasurementsCache();
      sensorHistory.clear();
      heatmapLoad.loadHeatmap();
      loads.loadMeasurements();
      comparison.loadCompare();
    },
  });

  // Keys 1-9 pick the heatmap's Lageplan - while there is more than one.
  const planHotkeys = !isSmartexIo && plans.length > 1;
  useAnalyseHotkeys({
    frameSeconds,
    frameTime,
    onFrameTime: setFrameTime,
    planHotkeys,
    plans,
    onPlan: pickPlan,
    rangeClear: offerNoiseProfiles && profileRange != null,
    onRangeClear: clearProfileRange,
  });

  const badge = offerNoiseProfiles
    ? noiseBadgeOf(t, noise.noiseView, noise.activeProfile, noise.testedProfile)
    : null;

  return (
    <div
      className="d-flex flex-column gap-4"
      data-testid="page-location-analyse"
    >
      <AnalyseActions
        offerNoiseProfiles={offerNoiseProfiles}
        exportMessage={exports.exportMsg}
        exportingPdf={exports.exportingPdf}
        onExportCsv={exports.exportCsv}
        onExportRawCsv={exports.exportRawCsv}
        onExportPdf={exports.exportPdf}
        onOpenArchive={() =>
          archive.setArchiveDialog({ allDevices: false, archive: true })
        }
        profileRange={profileRange}
        confirmDisable={sensorSwitch.confirmDisable}
        onConfirmDisableChange={sensorSwitch.setConfirmDisable}
        selectedEnabled={sensorSwitch.selectedEnabled}
        switchingSensors={sensorSwitch.switchingSensors}
        onSwitchSensors={sensorSwitch.switchSensors}
        archiveDialog={archive.archiveDialog}
        onArchiveDialogChange={archive.setArchiveDialog}
        archiveCounts={archive.archiveCounts}
        shownDevice={shownDevice}
        shownDeviceName={loads.shownDeviceName}
        archiving={archive.archiving}
        onApplyArchive={archive.applyArchive}
      />

      <AnalyseFrameControl
        mobile={
          typeof window !== 'undefined' && window.innerWidth < MOBILE_WIDTH
        }
        isSmartexIo={isSmartexIo}
        rangeOptions={period.rangeOptions}
        range={range}
        onRangeChange={(value) => {
          period.setSelectedRange(value);
          setFrameTime(null);
        }}
        resolution={resolution}
        onResolutionChange={period.setResolution}
        meanWindow={meanWindow}
        onMeanWindowChange={period.setMeanWindow}
        compareOptions={comparison.compareOptions}
        compare={comparison.compare}
        onCompareChange={comparison.setCompareDays}
        loading={heatmapLoad.heatmapLoading || loads.measurementsLoading}
        hasLoadedData={Boolean(heatmap || measurements.length > 0)}
        noiseBadge={badge ? <AnalyseNoiseBadge badge={badge} /> : null}
        frameSeconds={frameSeconds}
        frameIndex={frames.frameIndex}
        onTimeChange={setFrameTime}
        chartZoom={chartZoom}
        selection={offerNoiseProfiles ? profileRange : null}
        onSelectionChange={offerNoiseProfiles ? setProfileRange : undefined}
        keyHints={pageKeyHintsOf(t, {
          planHotkeys,
          planCount: plans.length,
          offerNoiseProfiles,
        })}
        tips={pageTipsOf(t, {
          offerNoiseProfiles,
          hasDraft: noise.shownDraft != null,
          hasRange: profileRange != null,
          noiseView: noise.noiseView,
          activeName: noise.activeProfile?.name ?? null,
        })}
      />

      {isSmartexIo ? (
        <AnalyseClimateSection
          locationId={locationId}
          range={range}
          showBattery={isStaff}
          time={frameTime}
          onTimeChange={setFrameTime}
          frameTime={frames.frameMs}
          onHeatmapFrames={frames.setClimateHeatmapFrames}
          onChartFrames={frames.setClimateChartFrames}
        />
      ) : (
        <AnalyseDeviceSection
          locationId={locationId}
          projectId={location?.project_id}
          isStaff={isStaff}
          canSwitchSensors={access.canSwitchSensors}
          offerNoiseProfiles={offerNoiseProfiles}
          range={range}
          heatmapFullscreen={heatmapFullscreen}
          heatmapOpen={heatmapOpen}
          onToggleHeatmap={() => setHeatmapOpen((open) => !open)}
          plans={plans}
          planId={planId}
          planHotkeys={planHotkeys}
          onPlanChange={pickPlan}
          heatProfile={heatProfile}
          onHeatProfileChange={period.setHeatProfile}
          heatmap={heatmapLoad}
          loads={loads}
          shown={shown}
          comparison={comparison}
          noise={noise}
          selection={selection}
          sensorSwitch={sensorSwitch}
          sensorHistory={sensorHistory}
          // Not while the period itself already reaches as far back.
          offerSensorHistory={isStaff && days < SENSOR_HISTORY_DAYS}
          alarmThreshold={alarmThreshold}
          sensorThresholds={sensorThresholds}
          frameTime={frameTime}
          onFrameTimeChange={setFrameTime}
          onChartZoom={setChartZoom}
          profileRange={profileRange}
          onProfileRangeChange={setProfileRange}
          onDeviceChange={pickDevice}
          onNoiseChanged={invalidateHeatmap}
        />
      )}
    </div>
  );
};

export default LocationAnalyseTab;
