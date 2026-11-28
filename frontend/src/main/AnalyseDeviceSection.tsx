import type { HeatProfile } from '../components/device/sensorHeatmapTypes';
import type { SensorNaming } from '../components/device/sensorNaming';
import { toggledSensor } from '../components/device/MeasurementSamplesCompareChart.tsx';
import MeasurementComparePlot from '../components/device/MeasurementComparePlot';
import type { useFullscreen } from '../components/ui/kit/Fullscreen';
import AnalyseHeatmapCard from './AnalyseHeatmapCard';
import AnalyseMeasurementsCard from './AnalyseMeasurementsCard';
import AnalyseNoisePanel from './AnalyseNoisePanel';
import type { ProfileRange } from './NoiseProfilePanel';
import type { TimeRange } from './timeRanges';
import type useAnalyseCompare from './useAnalyseCompare';
import type useAnalyseShown from './useAnalyseShown';
import type {
  useAnalyseHeatmap,
  useAnalyseMeasurements,
  useSensorHistory,
} from './useAnalyseLoads';
import type { NoiseProfileState } from './useNoiseProfileState';
import type useSensorSelection from './useSensorSelection';
import type useSensorSwitch from './useSensorSwitch';
import { planSwitcherOf } from './useAnalysePlans';

type AnalyseDeviceSectionProps = {
  locationId: number;
  projectId: number | null | undefined;
  isStaff: boolean;
  canSwitchSensors: boolean;
  offerNoiseProfiles: boolean;
  range: TimeRange;
  /** The heatmap on the whole screen (phones: the only way to read it). */
  heatmapFullscreen: ReturnType<typeof useFullscreen>;
  heatmapOpen: boolean;
  onToggleHeatmap: () => void;
  plans: readonly { id: number; name?: string | null }[];
  planId: number | null;
  planHotkeys: boolean;
  onPlanChange: (id: number) => void;
  heatProfile: HeatProfile;
  onHeatProfileChange: (profile: HeatProfile) => void;
  heatmap: ReturnType<typeof useAnalyseHeatmap>;
  loads: ReturnType<typeof useAnalyseMeasurements>;
  shown: ReturnType<typeof useAnalyseShown>;
  comparison: ReturnType<typeof useAnalyseCompare>;
  noise: NoiseProfileState;
  selection: ReturnType<typeof useSensorSelection>;
  sensorSwitch: ReturnType<typeof useSensorSwitch>;
  sensorHistory: ReturnType<typeof useSensorHistory>;
  offerSensorHistory: boolean;
  alarmThreshold: number | null;
  sensorThresholds: Map<number, number>;
  frameTime: number | null;
  onFrameTimeChange: (time: number | null) => void;
  onChartZoom: (zoom: { from: number; to: number } | null) => void;
  profileRange: ProfileRange | null;
  onProfileRangeChange: (range: ProfileRange | null) => void;
  onDeviceChange: (id: number) => void;
  /** Every device's measurements at once (analyseDevices.ts). */
  allDevices: boolean;
  onAllDevicesChange: (all: boolean) => void;
  /** All devices: the plots name a sensor by its device. */
  sensorNaming: SensorNaming | null;
  /** A profile or threshold changed: the heatmap loads again. */
  onNoiseChanged: () => void;
};

/**
 * The Analyse page of a sample-measuring object: the location heatmap, the
 * comparison with the past, the staff's Störungsprofil panel and the
 * measurements of the shown device.
 */
const AnalyseDeviceSection = ({
  locationId,
  projectId,
  isStaff,
  canSwitchSensors,
  offerNoiseProfiles,
  range,
  heatmapFullscreen,
  heatmapOpen,
  onToggleHeatmap,
  plans,
  planId,
  planHotkeys,
  onPlanChange,
  heatProfile,
  onHeatProfileChange,
  heatmap,
  loads,
  shown,
  comparison,
  noise,
  selection,
  sensorSwitch,
  sensorHistory,
  offerSensorHistory,
  alarmThreshold,
  sensorThresholds,
  frameTime,
  onFrameTimeChange,
  onChartZoom,
  profileRange,
  onProfileRangeChange,
  onDeviceChange,
  allDevices,
  onAllDevicesChange,
  sensorNaming,
  onNoiseChanged,
}: AnalyseDeviceSectionProps) => {
  const { compare, compareLabel } = comparison;
  const { sensors, changeSensors } = selection;
  return (
    <>
      <AnalyseHeatmapCard
        locationId={locationId}
        planId={planId}
        isStaff={isStaff}
        state={heatmapFullscreen}
        heatmapLoading={heatmap.heatmapLoading}
        heatmapOpen={heatmapOpen}
        onToggleOpen={onToggleHeatmap}
        compare={compare != null}
        compareLabel={compareLabel}
        shownHeatmap={shown.shownHeatmap}
        changeHeatmap={comparison.changeHeatmap}
        switchingPlan={shown.switchingPlan}
        planSwitcher={planSwitcherOf(plans, planId, planHotkeys, onPlanChange)}
        selectedPositions={selection.selectedPositions}
        focusedPosition={selection.focusedPosition}
        onAreaSelect={selection.selectPlanArea}
        onSensorClick={selection.selectPlanSensor}
        time={frameTime}
        onTimeChange={onFrameTimeChange}
        profile={heatProfile}
        onProfileChange={onHeatProfileChange}
        onPlanChange={onPlanChange}
      />

      {compare && (
        <MeasurementComparePlot
          rows={shown.shownMeasurements}
          pastRows={comparison.compareRowsShown ?? []}
          time={frameTime}
          offsetMs={comparison.compareOffsetMs}
          label={compareLabel}
          loading={comparison.compareLoading}
          onClose={() => comparison.setCompareDays(null)}
          selectedSensors={sensors}
          onSensorSelect={(sensor) =>
            changeSensors(toggledSensor(sensors, sensor))
          }
        />
      )}

      {/* A Störungsprofil is one device's - not with all of them. */}
      {offerNoiseProfiles && !allDevices && (
        <AnalyseNoisePanel
          locationId={locationId}
          projectId={projectId}
          noise={noise}
          shownDeviceName={loads.shownDeviceName}
          shownDevice={loads.shownDevice}
          measurements={loads.measurements}
          heatmap={heatmap.heatmap}
          range={range}
          frameTime={frameTime}
          profileRange={profileRange}
          onProfileRangeChange={onProfileRangeChange}
          alarmThreshold={alarmThreshold}
          sensorThresholds={sensorThresholds}
          onChanged={onNoiseChanged}
        />
      )}

      <AnalyseMeasurementsCard
        devices={loads.devices}
        shownDevice={loads.shownDevice}
        onDeviceChange={onDeviceChange}
        allDevices={allDevices}
        onAllDevicesChange={onAllDevicesChange}
        sensorNaming={sensorNaming}
        offlineSpans={loads.offline}
        canSwitchSensors={canSwitchSensors}
        sensors={sensors}
        selectedEnabled={sensorSwitch.selectedEnabled}
        selectedDisabled={sensorSwitch.selectedDisabled}
        switchingSensors={sensorSwitch.switchingSensors}
        onRequestDisable={() => sensorSwitch.setConfirmDisable(true)}
        onEnable={() => sensorSwitch.switchSensors(false)}
        measurementTotal={loads.measurementTotal}
        measurements={loads.measurements}
        measurementsLoading={loads.measurementsLoading}
        shownMeasurements={shown.shownMeasurements}
        onChartZoom={onChartZoom}
        frameTime={frameTime}
        onFrameTimeChange={onFrameTimeChange}
        onSensorsChange={changeSensors}
        offerSensorHistory={offerSensorHistory}
        shownSensorHistory={shown.shownSensorHistory}
        sensorHistoryLoading={sensorHistory.loading}
        onToggleSensorHistory={sensorHistory.toggle}
        threshold={alarmThreshold}
        sensorThresholds={sensorThresholds}
        disabledSensors={sensorSwitch.disabledSensors}
        maskLines={noise.maskLines}
        offerNoiseProfiles={offerNoiseProfiles}
        profileRange={profileRange}
        onProfileRangeChange={onProfileRangeChange}
      />
    </>
  );
};

export default AnalyseDeviceSection;
