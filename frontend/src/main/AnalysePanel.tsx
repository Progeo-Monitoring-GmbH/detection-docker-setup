import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProfileRange } from './NoiseProfilePanel';
import { useFullscreen } from '../components/ui/kit/Fullscreen';
import AnalyseActions from './AnalyseActions';
import AnalyseClimateSection from './AnalyseClimateSection';
import AnalyseDeviceSection from './AnalyseDeviceSection';
import AnalyseFrameControl from './AnalyseFrameControl';
import AnalyseNoiseBadge from './AnalyseNoiseBadge';
import { combinedPoints, namingOf } from './analyseDevices';
import { noiseBadgeOf } from './analyseNoiseView';
import { pageKeyHintsOf, pageTipsOf } from './analysePageHelp';
import { sensorThresholdsOf } from './analyseSelection';
import type { DeviceKind, LocationDetail } from './locationTypes';
import { TIME_RANGE_DAYS, type TimeRange } from './timeRanges';
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
  type useAnalyseAccess,
  type useAnalysePeriod,
  useLocationChoice,
} from './useAnalyseSettings';
import useAnalyseShown from './useAnalyseShown';
import useNoiseProfileState from './useNoiseProfileState';
import useSensorSelection from './useSensorSelection';
import useSensorSwitch from './useSensorSwitch';

const MOBILE_WIDTH = 860;

type AnalysePanelProps = {
  location: LocationDetail | null;
  locationId: number;
  /** What this panel shows: the leak heatmap and samples, or the climate
   * charts (smartex io). */
  kind: DeviceKind;
  /** The location has both kinds (tabs): the leak panel asks for the leak
   * devices only, the climate one shows no climate heatmap and no exports. */
  mixed: boolean;
  /** The period this panel loads - the page's, a hidden tab's after the
   * shown one has it (DeviceKindTabs). */
  range: TimeRange;
  access: ReturnType<typeof useAnalyseAccess>;
  /** The page's period settings - one for both tabs. */
  period: ReturnType<typeof useAnalysePeriod>;
  /** The period's data is there (or failed) - the other tab loads then. */
  onReady: () => void;
  /** Shown (not a preloaded tab): only then its keys work. */
  visible?: boolean;
};

const NO_FRAMES: number[] = [];

/**
 * One kind of the Analyse page: the heatmap plus the measurements of the
 * location's devices over the period, or the climate heatmap and charts of
 * smartex io sensors (AnalyseClimateSection) - with its frame slider and,
 * for leak, the exports, archive and Störungsprofile. The state lives in
 * the useAnalyse* hooks.
 */
const AnalysePanel = ({
  location,
  locationId,
  kind,
  mixed,
  range,
  access,
  period,
  onReady,
  visible = true,
}: AnalysePanelProps) => {
  const { t } = useTranslation();
  const isSmartexIo = kind === 'climate';
  const { isStaff } = access;
  // Leak only: the Störungsprofile, raw loads and switching sensors.
  const offerNoiseProfiles = access.offerNoiseProfiles && !isSmartexIo;
  const rawQuery = offerNoiseProfiles ? access.rawQuery : '';
  const canSwitchSensors = access.canSwitchSensors && !isSmartexIo;
  const { resolution, meanWindow, heatProfile } = period;
  const days = TIME_RANGE_DAYS[range];
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
  // backend's default - the device that measured last. Or all of them at
  // once ("Alle Geräte", analyseDevices.ts); picking one ends that.
  const [deviceId, pickDevice] = useLocationChoice<number>(locationId);
  const [allChoice, setAllChoice] = useLocationChoice<boolean>(locationId);
  const allDevices = allChoice ?? false;
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
  // The heatmaps (the period's and the comparison's) of a location with
  // climate sensors too: the leak devices only.
  const heatQuery = mixed && !isSmartexIo ? `${planQuery}&kind=leak` : planQuery;
  const exports = useAnalyseExports(locationId, location?.project_id);
  const loadOptions = { locationId, enabled: !isSmartexIo, days, resolution };
  const loads = useAnalyseMeasurements({
    ...loadOptions,
    deviceId,
    allDevices,
    rawQuery,
  });
  const { measurements, devices, shownDevice, layout } = loads;
  const pairLabel = t('measurement_compare_pair_label');
  const sensorNaming = useMemo(
    () => (layout ? namingOf(layout, pairLabel) : null),
    [layout, pairLabel],
  );
  const noise = useNoiseProfileState({
    locationId,
    offer: offerNoiseProfiles,
    shownDevice,
  });
  const { displayMask, heatNoiseQuery } = noise;
  const heatmapLoad = useAnalyseHeatmap({
    ...loadOptions,
    planQuery: heatQuery,
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
    planQuery: heatQuery,
    rawQuery,
    layout,
    displayMask,
    meanWindow,
    shownHeatmap: shown.shownHeatmap,
  });

  // Leak: the heatmap and the measurements of the period are there (or
  // failed) - an empty or refused one must not keep the other tab waiting.
  // Climate: its charts report it (AnalyseClimateSection).
  // A new period: its loads start in this commit's effects - the flags
  // still tell the old one's, so wait for the next render (a cached period
  // shows at once and renders again, too).
  const leakLoaded = !heatmapLoad.heatmapLoading && !loads.measurementsLoading;
  const loadedDays = useRef(days);
  useEffect(() => {
    if (loadedDays.current !== days) {
      loadedDays.current = days;
      return;
    }
    if (!isSmartexIo && leakLoaded) {
      onReady();
    }
  }, [days, heatmap, isSmartexIo, leakLoaded, measurements, onReady]);

  // The plan's sensors and the measurements' second plot (analyseSelection)
  // - all devices: on the pairs of the combined rows.
  const points = useMemo(() => {
    const planPoints = heatmap?.sensor_points ?? [];
    return layout ? combinedPoints(planPoints, layout) : planPoints;
  }, [heatmap, layout]);
  const selection = useSensorSelection({
    points,
    shownDevice,
    deviceIds: devices.map((device) => device.id),
    onDevice: pickDevice,
  });
  // The pairs mean other sensors in the other mode - the selection starts anew.
  const { changeSensors } = selection;
  const showAllDevices = (all: boolean) => {
    changeSensors([]);
    setAllChoice(all);
  };
  const showDevice = (id: number) => {
    if (allDevices) {
      changeSensors([]);
      setAllChoice(false);
    }
    pickDevice(id);
  };

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
  // A preloaded (hidden) tab listens to no keys - they are the shown one's.
  useAnalyseHotkeys({
    frameSeconds: visible ? frameSeconds : NO_FRAMES,
    frameTime,
    onFrameTime: setFrameTime,
    planHotkeys: planHotkeys && visible,
    plans,
    onPlan: pickPlan,
    rangeClear: visible && offerNoiseProfiles && profileRange != null,
    onRangeClear: clearProfileRange,
  });

  const badge = offerNoiseProfiles
    ? noiseBadgeOf(t, noise.noiseView, noise.activeProfile, noise.testedProfile)
    : null;

  return (
    <div className="d-flex flex-column gap-4">
      {/* The exports and the archive are the leak data's - not in the Klima tab. */}
      {!(isSmartexIo && mixed) && (
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
      )}

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
        offlineSpans={isSmartexIo ? undefined : loads.offline}
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
          withHeatmap={!mixed}
          onReady={onReady}
        />
      ) : (
        <AnalyseDeviceSection
          locationId={locationId}
          projectId={location?.project_id}
          isStaff={isStaff}
          canSwitchSensors={canSwitchSensors}
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
          // Not while the period itself already reaches as far back - nor
          // for all devices (it is one device's).
          offerSensorHistory={
            isStaff && days < SENSOR_HISTORY_DAYS && layout == null
          }
          alarmThreshold={alarmThreshold}
          sensorThresholds={sensorThresholds}
          frameTime={frameTime}
          onFrameTimeChange={setFrameTime}
          onChartZoom={setChartZoom}
          profileRange={profileRange}
          onProfileRangeChange={setProfileRange}
          onDeviceChange={showDevice}
          allDevices={allDevices}
          onAllDevicesChange={showAllDevices}
          sensorNaming={sensorNaming}
          onNoiseChanged={invalidateHeatmap}
        />
      )}
    </div>
  );
};

export default AnalysePanel;
