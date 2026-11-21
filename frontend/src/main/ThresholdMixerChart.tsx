import type { KeyboardEvent, PointerEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import PillButton from '../components/ui/kit/PillButton';
import { WheelZoomHint } from '../components/ui/wheelZoom';
import { childTestId, repeatedTestId } from '../testIds';
import { effectiveThresholdOf, isDisabled, type MixerSensor, overrideOf } from './thresholdMixer';
import ThresholdMixerPlot from './ThresholdMixerPlot';
import {
  formatValue,
  gridOf,
  GUTTER,
  type MixerState,
  MUTED,
  OBJECT_LINE,
  scrollViewOf,
  sensorLabelOf,
  SVG_H,
} from './thresholdMixerView';
import type useThresholdMixerDrag from './useThresholdMixerDrag';
import type useThresholdMixerScroller from './useThresholdMixerScroller';

type Pointer = ReturnType<typeof useThresholdMixerDrag>;
type Scroller = ReturnType<typeof useThresholdMixerScroller>;
type ScrollView = ReturnType<typeof scrollViewOf>;

/** The y-axis with the object grip - it stays put while the columns scroll. */
const ThresholdMixerAxis = ({
  testId,
  canEdit,
  gridValues,
  toY,
  scale,
  objectThreshold,
  gripHandlers,
}: {
  testId: string;
  canEdit: boolean;
  gridValues: number[];
  toY: (value: number) => number;
  scale: number;
  objectThreshold: number | null;
  gripHandlers: {
    onPointerDown: (event: PointerEvent<SVGElement>) => void;
    onPointerMove: (event: PointerEvent<SVGElement>) => void;
    onPointerUp: () => void;
    onKeyDown: (event: KeyboardEvent) => void;
  };
}) => {
  const { t } = useTranslation();
  return (
    <svg width={GUTTER} height={SVG_H} className="threshold-mixer-gutter" aria-hidden={!canEdit}>
      {gridValues.map((tick) => (
        <text key={tick} x={GUTTER - 8} y={toY(tick) + 3} textAnchor="end" fontSize={10} fill={MUTED}>
          {tick}
        </text>
      ))}
      {objectThreshold != null && (
        <g
          role="slider"
          tabIndex={canEdit ? 0 : -1}
          aria-label={t('einstell_alarm_threshold')}
          aria-valuenow={objectThreshold}
          aria-valuemin={0}
          aria-valuemax={Math.round(scale)}
          className={canEdit ? 'threshold-mixer-grip threshold-mixer-grip--editable' : 'threshold-mixer-grip'}
          data-testid={childTestId(testId, 'grip')}
          {...gripHandlers}
        >
          <rect x={2} y={toY(objectThreshold) - 9} width={GUTTER - 6} height={18} rx={9} fill={OBJECT_LINE} />
          <text x={GUTTER / 2 - 1} y={toY(objectThreshold) + 4} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="#fff">
            {formatValue(objectThreshold)}
          </text>
        </g>
      )}
    </svg>
  );
};

/** A scroll button at the plot's edge: most of a page to that side. */
const ScrollEdge = ({ side, onScroll, testId }: { side: 'left' | 'right'; onScroll: () => void; testId: string }) => {
  const { t } = useTranslation();
  const label = t(side === 'left' ? 'einstell_mixer_scroll_left' : 'einstell_mixer_scroll_right');
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onScroll}
      className={`threshold-mixer-edge threshold-mixer-edge--${side}`}
      {...repeatedTestId(`${testId}-scroll`, side)}
    >
      {side === 'left' ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
    </button>
  );
};

/** The hovered sensor: name, maximum, threshold (own or the object's). */
const ThresholdMixerTooltip = ({
  testId,
  canEdit,
  sensor,
  sensors,
  state,
}: {
  testId: string;
  canEdit: boolean;
  sensor: MixerSensor;
  sensors: MixerSensor[];
  state: MixerState;
}) => {
  const { t } = useTranslation();
  const own = overrideOf(sensor, state.drafts) != null;
  return (
    <div className="threshold-mixer-tooltip" data-testid={childTestId(testId, 'tooltip')}>
      <div className="threshold-mixer-tooltip-title">{sensorLabelOf(sensors, sensor.sensor_order, t)}</div>
      {isDisabled(sensor, state.drafts) && (
        <div className="threshold-mixer-tooltip-disabled">{t('einstell_mixer_disabled_hint')}</div>
      )}
      <div>
        {t('einstell_mixer_max')}: {formatValue(sensor.max)} mV
      </div>
      <div>
        {t('einstell_points_threshold')}: {formatValue(effectiveThresholdOf(sensor, state.savedObject, state.drafts))} mV
        <span className="threshold-mixer-tooltip-dim">
          {' '}
          ({own ? t('einstell_mixer_own') : t('einstell_mixer_object')})
        </span>
      </div>
      {canEdit && own && <div className="threshold-mixer-tooltip-dim">{t('einstell_mixer_marker_hint')}</div>}
      {canEdit && <div className="threshold-mixer-tooltip-dim">{t('einstell_mixer_bar_hint')}</div>}
    </div>
  );
};

/** The mixer's chart: the fixed y-axis, the scrolling plot with its edge buttons, the tooltip. */
const ThresholdMixerChart = ({
  testId,
  canEdit,
  sensors,
  columns,
  state,
  objectThreshold,
  pointer,
  scroller,
  scrollView,
}: {
  testId: string;
  canEdit: boolean;
  sensors: MixerSensor[];
  columns: MixerSensor[];
  state: MixerState;
  objectThreshold: number | null;
  pointer: Pointer;
  scroller: Scroller;
  scrollView: ScrollView;
}) => {
  const { t } = useTranslation();
  const gridValues = gridOf(pointer.scale);
  const hoveredSensor = sensors.find((sensor) => sensor.sensor_order === pointer.hovered) ?? null;
  const page = scroller.scroll.client * 0.9;
  const { scrollable, atStart, atEnd } = scrollView;
  return (
    <div className="threshold-mixer-chart" data-testid={childTestId(testId, 'chart')}>
      <ThresholdMixerAxis
        testId={testId}
        canEdit={canEdit}
        gridValues={gridValues}
        toY={pointer.toY}
        scale={pointer.scale}
        objectThreshold={objectThreshold}
        gripHandlers={pointer.gripHandlers}
      />

      <div className="threshold-mixer-scroll-wrap">
        <div
          {...scroller.scrollerProps}
          tabIndex={0}
          role="group"
          aria-label={t('einstell_mixer_plot_label')}
          className="threshold-mixer-scroller"
          data-testid={childTestId(testId, 'scroller')}
        >
          <ThresholdMixerPlot
            testId={testId}
            columns={columns}
            column={scroller.column}
            plotWidth={scroller.plotWidth}
            gridValues={gridValues}
            toY={pointer.toY}
            objectThreshold={objectThreshold}
            state={state}
            hovered={pointer.hovered}
            handlers={pointer.plotHandlers}
          />
          <WheelZoomHint visible={scroller.wheelHint} radius={0} />
        </div>
        {scrollable && !atStart && <ScrollEdge side="left" onScroll={() => scroller.scrollBy(-page)} testId={testId} />}
        {scrollable && !atEnd && <ScrollEdge side="right" onScroll={() => scroller.scrollBy(page)} testId={testId} />}
      </div>

      {hoveredSensor && !pointer.drag && (
        <ThresholdMixerTooltip testId={testId} canEdit={canEdit} sensor={hoveredSensor} sensors={sensors} state={state} />
      )}
    </div>
  );
};

/** Above the chart: which sensors the scroller shows, and the quiet ones' toggle. */
export const ThresholdMixerRange = ({
  testId,
  scrollView,
  shown,
  quietHidden,
  quietCount,
  hideQuiet,
  onToggleQuiet,
}: {
  testId: string;
  scrollView: ScrollView;
  /** Columns in the plot. */
  shown: number;
  quietHidden: number;
  quietCount: number;
  hideQuiet: boolean;
  onToggleQuiet: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <div className="d-flex align-items-center gap-2 flex-wrap mb-1 threshold-mixer-muted">
      <span data-testid={childTestId(testId, 'range')}>
        {scrollView.scrollable
          ? t('einstell_mixer_range', { first: scrollView.firstShown, last: scrollView.lastShown, total: shown })
          : t('einstell_mixer_all_shown', { total: shown })}
        {quietHidden > 0 && ` · ${t('einstell_mixer_quiet_hidden', { count: quietHidden })}`}
      </span>
      <span className="threshold-mixer-spacer" />
      <PillButton
        variant={hideQuiet ? 'accent' : 'ghost'}
        label={t('einstell_mixer_hide_quiet', { count: quietCount })}
        title={t('einstell_mixer_hide_quiet_hint', { percent: 5 })}
        disabled={quietCount === 0 && !hideQuiet}
        onClick={onToggleQuiet}
        testId={childTestId(testId, 'hide-quiet')}
      />
    </div>
  );
};

export default ThresholdMixerChart;
