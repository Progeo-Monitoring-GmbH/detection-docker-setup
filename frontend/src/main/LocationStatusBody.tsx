import { useTranslation } from 'react-i18next';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import LocationBatteryVoltagePanel from './LocationBatteryVoltagePanel';
import LocationStatusRoof from './LocationStatusRoof';
import { anlageStatusOf } from './locationStatusData';
import type { LocationDetail } from './locationTypes';
import { planVisualization, showsSensorTable } from './projectType';
import { StatusKpiSection } from './StatusKpis';
import TimeRangeSelect from './TimeRangeSelect';
import { LATEST_RANGE, type StatusRange, type TimeRange } from './timeRanges';
import type { useStatusHistory, useStatusRange } from './useStatusHistory';
import {
  useAlarmSpans,
  useSensorLabels,
  useZeitreiheSensors,
} from './useStatusSensors';
import type { useStatusSuspicions } from './useStatusSuspicions';
import {
  type StatusViewMode,
  useShowMoment,
  type useStatusViewSettings,
} from './useStatusViewSettings';
import ZeitreihePanel from './ZeitreihePanel';
import './LocationStatusView.css';

/** The view (roof / Zeitreihe) and the range of both. */
const StatusSwitches = ({
  view,
  onViewChange,
  range,
  rangeOptions,
  onRangeChange,
}: {
  view: StatusViewMode;
  onViewChange: (view: StatusViewMode) => void;
  range: StatusRange;
  rangeOptions: TimeRange[];
  onRangeChange: (range: StatusRange) => void;
}) => {
  const { t } = useTranslation();
  return (
    <div className="status-switches" data-testid="status-switches">
      <SegmentedControl
        testId="status-view-switch"
        options={[
          { value: 'roof', label: t('status_view_roof') },
          { value: 'zeitreihe', label: t('status_view_zeitreihe') },
        ]}
        value={view}
        onChange={(value) => onViewChange(value as StatusViewMode)}
      />
      <TimeRangeSelect<StatusRange>
        testId="status-range"
        ranges={[LATEST_RANGE, ...rangeOptions]}
        value={range}
        onChange={onRangeChange}
      />
    </div>
  );
};

/** The Zeitreihe - staff: with the battery chart (device maintenance). */
const StatusZeitreihe = ({
  requestedIds,
  battery,
  locationId,
  days,
  demo,
  ...panel
}: Omit<Parameters<typeof ZeitreihePanel>[0], 'requestedIds'> & {
  requestedIds: string[] | undefined;
  battery: boolean;
  locationId: number;
  days: number;
  demo: boolean;
}) => (
  <>
    <ZeitreihePanel {...panel} requestedIds={requestedIds ?? null} />
    {battery && (
      <LocationBatteryVoltagePanel
        locationId={locationId}
        days={days}
        demo={demo}
      />
    )}
  </>
);

/**
 * The status page of an object with samples (not LoRaWAN): the KPIs, the
 * view and range switches and the roof view (plan and Verdachtsstellen) or
 * the Zeitreihe (staff: with the battery chart). The data comes from
 * LocationStatusView's hooks.
 */
const LocationStatusBody = ({
  location,
  locationId,
  demo,
  isStaff,
  settings,
  ranges,
  shown,
  suspicions,
  onFrameTimeChange,
  onZeitreiheShown,
}: {
  location: LocationDetail | null;
  locationId: number;
  demo: boolean;
  isStaff: boolean;
  settings: ReturnType<typeof useStatusViewSettings>;
  ranges: ReturnType<typeof useStatusRange>;
  shown: ReturnType<typeof useStatusHistory>;
  suspicions: ReturnType<typeof useStatusSuspicions>;
  onFrameTimeChange: (ms: number | null) => void;
  onZeitreiheShown: (ids: string[]) => void;
}) => {
  const clusters = suspicions.alarmClusters;
  const threshold = location?.alarm_threshold ?? null;
  const visualization = planVisualization(location?.project_type);
  const sensors = useSensorLabels(shown.history, visualization);
  const zeitreiheSensors = useZeitreiheSensors(
    shown.zeitreihe,
    sensors,
    threshold,
  );
  const alarmSpans = useAlarmSpans(
    clusters.clusters,
    clusters.loadedAt ?? settings.openedAt,
    sensors.sensorLabel,
  );
  const showMoment = useShowMoment(
    settings,
    ranges.range,
    shown.now,
    ranges.rangeOptions,
  );

  return (
    <>
      <StatusKpiSection
        loading={clusters.loading || shown.loading}
        denied={clusters.denied}
        clusters={clusters.clusters}
        openSuspicions={suspicions.openSuspicions}
        threshold={threshold}
        anlage={anlageStatusOf(
          ranges.measurementRange,
          ranges.measurementRangeFailed,
          shown.now,
        )}
        now={shown.now}
      />

      <StatusSwitches
        view={settings.statusView}
        onViewChange={settings.setStatusView}
        range={ranges.range}
        rangeOptions={ranges.rangeOptions}
        onRangeChange={settings.selectRange}
      />

      {settings.statusView === 'zeitreihe' ? (
        <StatusZeitreihe
          loading={shown.loading}
          sensors={zeitreiheSensors}
          selectedSensorId={settings.selectedSensor}
          requestedIds={settings.requested.sensors}
          onShownChange={onZeitreiheShown}
          battery={isStaff}
          locationId={locationId}
          days={ranges.rangeDays}
          demo={demo}
        />
      ) : (
        <LocationStatusRoof
          settings={settings}
          shown={shown}
          suspicions={suspicions}
          sensors={sensors}
          alarmSpans={alarmSpans}
          visualization={visualization}
          withSensorTable={showsSensorTable(location?.project_type)}
          threshold={threshold}
          isLatest={ranges.isLatest}
          isStaff={isStaff}
          demo={demo}
          onFrameTimeChange={onFrameTimeChange}
          onShowMoment={showMoment}
        />
      )}
    </>
  );
};

export default LocationStatusBody;
