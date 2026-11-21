import { useTranslation } from 'react-i18next';
import type { AlarmSpan } from '../components/device/FrameSlider';
import type { HeatmapStep } from '../components/device/heatmapSteps';
import PillSelect from '../components/ui/kit/PillSelect';
import ComputedSuspicionPanel, {
  SuspicionModeSwitch,
} from './ComputedSuspicionPanel';
import LocationPlanPanel from './LocationPlanPanel';
import { planFromParams } from './planParam';
import type { PlanVisualization } from './projectType';
import type { useStatusHistory } from './useStatusHistory';
import type { useSensorLabels } from './useStatusSensors';
import type { useStatusSuspicions } from './useStatusSuspicions';
import type { useStatusViewSettings } from './useStatusViewSettings';
import VerdachtsstellenPanel from './VerdachtsstellenPanel';
import './LocationStatusView.css';

type Settings = ReturnType<typeof useStatusViewSettings>;
type Shown = ReturnType<typeof useStatusHistory>;
type Suspicions = ReturnType<typeof useStatusSuspicions>;
type Sensors = ReturnType<typeof useSensorLabels>;

/** The plan's step - only for a period with more than one step to pick. */
const StepSelect = ({
  options,
  value,
  onChange,
}: {
  options: HeatmapStep[];
  value: number;
  onChange: (step: number) => void;
}) => {
  const { t } = useTranslation();
  return (
    <PillSelect
      testId="status-step"
      label={t('heatmap_step_label')}
      title={t('heatmap_step_hint')}
      options={options.map((step) => ({
        value: String(step.seconds),
        label: t(`heatmap_step_${step.key}`),
      }))}
      value={String(value)}
      onChange={(picked) => onChange(Number(picked))}
    />
  );
};

/** Beside the plan: the computed suspicion points, or one Verdachtsstelle
 * per sensor (staff can switch in the panel's header). */
const SuspicionColumn = ({
  suspicions: {
    suspicionMode,
    setSuspicionMode,
    computed,
    alarmClusters: clusters,
  },
  sensors,
  isStaff,
  demo,
  onSensorHover,
  onShowMoment,
}: {
  suspicions: Suspicions;
  sensors: Sensors;
  isStaff: boolean;
  demo: boolean;
  onSensorHover: (sensorId: number | null) => void;
  onShowMoment: (iso: string) => void;
}) => {
  // In the panel's header - a row of its own pushed the panel below the plan's top.
  const suspicionSwitch = isStaff ? (
    <SuspicionModeSwitch mode={suspicionMode} onChange={setSuspicionMode} />
  ) : undefined;

  return suspicionMode === 'computed' ? (
    <ComputedSuspicionPanel
      points={computed.points}
      loading={computed.loading}
      denied={computed.denied}
      sensorLabel={sensors.sensorLabel}
      acknowledging={computed.acknowledging}
      onAcknowledge={computed.acknowledge}
      readOnly={demo}
      headerActions={suspicionSwitch}
      onSensorHover={onSensorHover}
      onShowMoment={onShowMoment}
    />
  ) : (
    <VerdachtsstellenPanel
      clusters={clusters.clusters}
      denied={clusters.denied}
      sensorLabel={sensors.sensorLabel}
      metersOf={sensors.metersOf}
      disabledOf={sensors.disabledOf}
      acknowledging={clusters.acknowledging}
      onAcknowledge={clusters.acknowledge}
      readOnly={demo}
      headerActions={suspicionSwitch}
      onShowMoment={onShowMoment}
    />
  );
};

/** The roof view: the plan (heatmap, frames, sensor table) and beside it the
 * Verdachtsstellen. */
const LocationStatusRoof = ({
  settings,
  shown,
  suspicions,
  sensors,
  alarmSpans,
  visualization,
  withSensorTable,
  threshold,
  isLatest,
  isStaff,
  demo,
  onFrameTimeChange,
  onShowMoment,
}: {
  settings: Settings;
  shown: Shown;
  suspicions: Suspicions;
  sensors: Sensors;
  alarmSpans: AlarmSpan[];
  visualization: PlanVisualization;
  withSensorTable: boolean;
  threshold: number | null;
  isLatest: boolean;
  isStaff: boolean;
  demo: boolean;
  onFrameTimeChange: (ms: number | null) => void;
  onShowMoment: (iso: string) => void;
}) => (
  <div className="status-columns" data-testid="status-roof">
    <div className="status-column-plan">
      <LocationPlanPanel
        preferredPlanId={planFromParams(settings.searchParams)}
        heatmap={shown.heatmap}
        visualization={visualization}
        withSensorTable={withSensorTable}
        threshold={threshold}
        denied={shown.denied}
        alarmSpans={alarmSpans}
        profileHeatmap={shown.profileHeatmap}
        profile={settings.heatProfile}
        onProfileChange={settings.setHeatProfile}
        profileLoading={shown.profileLoading}
        focusTime={settings.jump?.at ?? settings.focusAt}
        focusRevision={settings.jump?.revision ?? 0}
        // The step only matters for the animation: beside its start.
        frameToolbar={
          !isLatest &&
          shown.stepOptions.length > 1 && (
            <StepSelect
              options={shown.stepOptions}
              value={shown.heatmapStep}
              onChange={settings.setPickedStep}
            />
          )
        }
        selectedSensor={settings.selectedSensor}
        onSensorSelect={settings.toggleSensor}
        suspicions={suspicions.suspicionMarkers}
        highlightedSensor={settings.hoveredSensor}
        onFrameTimeChange={onFrameTimeChange}
      />
    </div>
    <div className="status-column-side">
      <SuspicionColumn
        suspicions={suspicions}
        sensors={sensors}
        isStaff={isStaff}
        demo={demo}
        onSensorHover={settings.setHoveredSensor}
        onShowMoment={onShowMoment}
      />
    </div>
  </div>
);

export default LocationStatusRoof;
