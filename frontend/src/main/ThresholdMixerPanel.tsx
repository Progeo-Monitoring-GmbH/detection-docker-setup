import type { ReactNode } from 'react';
import { Spinner } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import PanelCard from '../components/ui/kit/PanelCard';
import { childTestId } from '../testIds';
import './ThresholdMixer.css';
import type { MixerSensor } from './thresholdMixer';
import ThresholdMixerBulkBar from './ThresholdMixerBulkBar';
import ThresholdMixerChanges from './ThresholdMixerChanges';
import ThresholdMixerChart, { ThresholdMixerRange } from './ThresholdMixerChart';
import ThresholdMixerObjectRow, { ThresholdMixerSource } from './ThresholdMixerHeader';
import ThresholdMixerLegend from './ThresholdMixerLegend';
import useThresholdMixer from './useThresholdMixer';

type Mixer = ReturnType<typeof useThresholdMixer>;

/** The chart's place: a spinner while the first sensors load, a note without any. */
const MixerContent = ({
  testId,
  loading,
  empty,
  children,
}: {
  testId: string;
  loading: boolean;
  empty: boolean;
  children: ReactNode;
}) => {
  const { t } = useTranslation();
  if (empty && loading) {
    return (
      <div className="d-flex justify-content-center py-5 text-muted" data-testid={childTestId(testId, 'loading')}>
        <Spinner animation="border" size="sm" />
      </div>
    );
  }
  if (empty) {
    return <div className="threshold-mixer-empty" data-testid={childTestId(testId, 'empty')}>{t('einstell_points_empty')}</div>;
  }
  return <div className={loading ? 'threshold-mixer-loading' : undefined}>{children}</div>;
};

/** Which sensors are shown (and the quiet ones' toggle) above the chart. */
const MixerChartSection = ({ testId, canEdit, mixer }: { testId: string; canEdit: boolean; mixer: Mixer }) => (
  <MixerContent testId={testId} loading={mixer.loading} empty={mixer.sensors.length === 0}>
    <ThresholdMixerRange
      testId={testId}
      scrollView={mixer.scrollView}
      shown={mixer.columns.length}
      quietHidden={mixer.sensors.length - mixer.columns.length}
      quietCount={mixer.quietOrders.size}
      hideQuiet={mixer.hideQuiet}
      onToggleQuiet={mixer.toggleQuiet}
    />
    <ThresholdMixerChart
      testId={testId}
      canEdit={canEdit}
      sensors={mixer.sensors}
      columns={mixer.columns}
      state={mixer.state}
      objectThreshold={mixer.objectThreshold}
      pointer={mixer.pointer}
      scroller={mixer.scroller}
      scrollView={mixer.scrollView}
    />
  </MixerContent>
);

type ThresholdMixerPanelProps = {
  locationId: number | string;
  initialObjectThreshold: number | null;
  canEdit: boolean;
  onSaved?: () => void;
  /** Inside another panel (the Analyse tab's Störungsprofil): no card of its own. */
  embedded?: boolean;
  /**
   * The sensors from data the page already loaded (mixerSensorsFromLoaded) -
   * then nothing is requested and there is no period to pick; `note` says
   * where the maxima come from. Without: the panel loads GET measurepoints
   * with the period's maxima itself (the Einstellungen tab).
   */
  loaded?: { sensors: MixerSensor[]; note: string } | null;
  /** data-testid of the panel; its parts are "<testId>-<part>" (src/testIds.ts). */
  testId?: string;
};

/**
 * Schwellwerte as a mixing desk: per sensor a bar of its highest alarm value
 * |WP - EP| in the period, the object's threshold as an orange line (drag
 * its grip in the axis, or type it) and every individual threshold as a blue
 * handle to drag up and down. A click on a bar switches the sensor off / on
 * (gray, disabledSensors.ts), a click above it - or a drag out of the bar -
 * sets its own threshold there. Ctrl/⌘ + click selects a sensor (Shift: a
 * range); dragging a selected one moves them all, and the selection
 * can be set to a value or lose its individual thresholds at once. Built for
 * 4 as for 500 sensors: columns keep a minimum width and scroll, Ctrl/⌘ +
 * wheel zooms them. Edits stay drafts - the panel next to "Speichern" lists
 * them, each undoable - and only real changes are saved. `onSaved` follows
 * every save (e.g. the Analyse tab reloads what depends on the thresholds).
 *
 * State: useThresholdMixer (data, pointer, scroller, save hooks); what is
 * drawn: thresholdMixerView.ts, ThresholdMixerChart / ThresholdMixerPlot.
 */
const ThresholdMixerPanel = ({
  locationId,
  initialObjectThreshold,
  canEdit,
  onSaved,
  embedded = false,
  loaded = null,
  testId = 'threshold-mixer',
}: ThresholdMixerPanelProps) => {
  const { t } = useTranslation();
  const mixer = useThresholdMixer({
    locationId,
    initialObjectThreshold,
    canEdit,
    onSaved,
    loadedSensors: loaded?.sensors ?? null,
  });
  return (
    <PanelCard
      testId={testId}
      flat={embedded}
      title={t('einstell_section_thresholds')}
      actions={<ThresholdMixerSource testId={testId} note={loaded?.note ?? null} days={mixer.days} onPeriod={mixer.pickPeriod} />}
    >
      <div className="d-flex flex-column gap-3">
        <ThresholdMixerObjectRow
          testId={testId}
          canEdit={canEdit}
          objectThreshold={mixer.objectThreshold}
          step={mixer.pointer.step}
          onChange={mixer.setObject}
        />
        <ThresholdMixerLegend testId={testId} canEdit={canEdit} counts={mixer.counts} />
        <MixerChartSection testId={testId} canEdit={canEdit} mixer={mixer} />
        {canEdit && mixer.sensors.length > 0 && (
          <ThresholdMixerBulkBar
            testId={testId}
            sensors={mixer.sensors}
            orders={mixer.orders}
            state={mixer.state}
            overCount={mixer.counts.over}
            setSelected={mixer.selection.setSelected}
            setDrafts={mixer.setDrafts}
            bulkValue={mixer.selection.bulkValue}
            setBulkValue={mixer.selection.setBulkValue}
          />
        )}
        {canEdit && (
          <ThresholdMixerChanges
            testId={testId}
            sensors={mixer.sensors}
            changes={mixer.changes}
            drafts={mixer.drafts}
            setDrafts={mixer.setDrafts}
            objectThreshold={mixer.objectThreshold}
            saving={mixer.saving}
            onSave={mixer.save}
          />
        )}
      </div>
    </PanelCard>
  );
};

export default ThresholdMixerPanel;
