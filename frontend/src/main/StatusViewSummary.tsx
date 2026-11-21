import { useTranslation } from 'react-i18next';
import { HEATMAP_STEPS } from '../components/device/heatmapSteps';
import { formatDate } from './dateFormat';
import type { StatusViewState } from './statusViewState';
import { timeRangeLabelKey } from './timeRanges';

/** A Zeitreihe entry id as a short label: "sensor-3" -> "#3", "3:0" -> "#3.1". */
const sensorEntryLabel = (id: string) => {
  const whole = /^sensor-(\d+)$/.exec(id);
  if (whole) {
    return `#${whole[1]}`;
  }
  const [sensor, part] = id.split(':');
  return `#${sensor}.${Number(part) + 1}`;
};

/**
 * The settings of a status view (an escalation's view_state) as label /
 * value pairs - what its quick link opens.
 */
const StatusViewSummary = ({
  state,
  testId,
}: {
  state: StatusViewState;
  testId?: string;
}) => {
  const { t } = useTranslation();
  const step = state.step
    ? HEATMAP_STEPS.find((entry) => entry.seconds === state.step)
    : undefined;
  const rows: [string, string, string][] = [];
  if (state.view) {
    rows.push([
      'view',
      t('escalation_view_view'),
      t(state.view === 'roof' ? 'status_view_roof' : 'status_view_zeitreihe'),
    ]);
  }
  if (state.range) {
    rows.push([
      'range',
      t('escalation_view_range'),
      t(timeRangeLabelKey(state.range)),
    ]);
  }
  if (state.step) {
    rows.push([
      'step',
      t('heatmap_step_label'),
      step
        ? t(`heatmap_step_${step.key}`)
        : `${Math.round(state.step / 60)} min`,
    ]);
  }
  if (state.at) {
    rows.push(['at', t('escalation_view_frame'), formatDate(state.at)]);
  }
  if (state.sensor != null) {
    rows.push([
      'sensor',
      t('escalation_view_sensor'),
      t('status_sensor_label', { sensor: state.sensor }),
    ]);
  }
  if (state.sensors?.length) {
    rows.push([
      'sensors',
      t('escalation_view_sensors'),
      state.sensors.map(sensorEntryLabel).join(', '),
    ]);
  }
  if (state.profile) {
    rows.push([
      'profile',
      t('escalation_view_profile'),
      t(`heatmap_profile_${state.profile}`),
    ]);
  }
  return (
    <dl className="status-view-summary" data-testid={testId}>
      {rows.map(([key, label, value]) => (
        <div key={key} className="status-view-summary-row" data-test-key={key}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
};

export default StatusViewSummary;
