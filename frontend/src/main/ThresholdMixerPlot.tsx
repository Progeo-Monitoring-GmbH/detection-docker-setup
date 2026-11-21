import { type PointerEvent, useId } from 'react';
import { DISABLED_SENSOR_STROKE } from '../components/device/disabledSensors';
import { childTestId, repeatedTestId } from '../testIds';
import { effectiveThresholdOf, isDisabled, labelEveryOf, type MixerSensor, overrideOf } from './thresholdMixer';
import {
  BAR_OVER,
  barFillOf,
  GRID,
  HOVER_BG,
  HOVER_OUTLINE,
  type MixerState,
  MUTED,
  OBJECT_LINE,
  OWN,
  PLOT_BOTTOM,
  PLOT_H,
  PLOT_TOP,
  SELECTED_BG,
  SVG_H,
} from './thresholdMixerView';

type ColumnProps = {
  sensor: MixerSensor;
  x: number;
  column: number;
  /** Its x-axis label is drawn (every n-th sensor). */
  labelled: boolean;
  state: MixerState;
  hovered: boolean;
  toY: (value: number) => number;
  stripesId: string;
  testId: string;
};

/** The sensor's bar: its period's maximum. */
const ColumnBar = ({ sensor, max, x, column, state, hovered, toY, stripesId }: ColumnProps & { max: number }) => {
  const barWidth = Math.max(1, column * 0.62);
  const y = toY(max);
  return (
    <rect
      data-bar
      x={x + (column - barWidth) / 2}
      y={y}
      width={barWidth}
      height={Math.max(1, PLOT_BOTTOM - y)}
      rx={Math.min(3, barWidth / 3)}
      fill={barFillOf(sensor, state, stripesId)}
      stroke={hovered ? HOVER_OUTLINE : 'none'}
      strokeWidth={hovered ? 1.5 : 0}
    />
  );
};

/** The marker of its threshold: filled for its own, hollow while selected and inheriting - none else. */
const ColumnHandle = ({ sensor, x, column, state, toY }: ColumnProps) => {
  const own = overrideOf(sensor, state.drafts) != null;
  const effective = effectiveThresholdOf(sensor, state.savedObject, state.drafts);
  if (effective == null || !(own || state.selected.has(sensor.sensor_order))) {
    return null;
  }
  return (
    <rect
      data-handle={sensor.sensor_order}
      x={x + column * 0.05}
      y={toY(effective) - 3}
      width={column * 0.9}
      height={6}
      rx={3}
      fill={own ? OWN : '#fff'}
      stroke={OWN}
      strokeWidth={own ? 0 : 1.5}
    />
  );
};

/** The x-axis label: the sensor's number, struck through in grey when it is off. */
const ColumnLabel = ({ order, x, column, off }: { order: number; x: number; column: number; off: boolean }) => (
  <text
    x={x + column / 2}
    y={SVG_H - 8}
    textAnchor="middle"
    fontSize={10}
    fill={off ? DISABLED_SENSOR_STROKE : MUTED}
    textDecoration={off ? 'line-through' : undefined}
  >
    {order}
  </text>
);

/** One sensor's column: highlight, bar, marker and x-axis label. Disabled sensors keep their grey. */
const ThresholdMixerColumn = (props: ColumnProps) => {
  const { sensor, x, column, labelled, state, hovered, testId } = props;
  const order = sensor.sensor_order;
  const off = isDisabled(sensor, state.drafts);
  const highlight = state.selected.has(order) ? SELECTED_BG : hovered && HOVER_BG;
  return (
    <g data-sensor={order} data-disabled={off || undefined} {...repeatedTestId(`${testId}-column`, order)}>
      {highlight && <rect x={x} y={PLOT_TOP} width={column} height={PLOT_H} fill={highlight} />}
      {sensor.max != null && <ColumnBar {...props} max={sensor.max} />}
      <ColumnHandle {...props} />
      {labelled && <ColumnLabel order={order} x={x} column={column} off={off} />}
    </g>
  );
};

/**
 * The scrolling plot: a column per sensor over the grid, the object's
 * threshold as one orange line across them. `handlers`: the pointer
 * (useThresholdMixerDrag).
 */
const ThresholdMixerPlot = ({
  testId,
  columns,
  column,
  plotWidth,
  gridValues,
  toY,
  objectThreshold,
  state,
  hovered,
  handlers,
}: {
  testId: string;
  columns: MixerSensor[];
  column: number;
  plotWidth: number;
  gridValues: number[];
  toY: (value: number) => number;
  objectThreshold: number | null;
  state: MixerState;
  hovered: number | null;
  handlers: {
    onPointerDown: (event: PointerEvent<SVGSVGElement>) => void;
    onPointerMove: (event: PointerEvent<SVGSVGElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onPointerLeave: () => void;
  };
}) => {
  const stripesId = `mixer-protected-${useId().replace(/:/g, '')}`;
  const every = labelEveryOf(column);
  return (
    <svg
      width={plotWidth}
      height={SVG_H}
      className="threshold-mixer-plot"
      {...handlers}
      data-testid={childTestId(testId, 'plot')}
    >
      <defs>
        {/* Protected by its own threshold, but above the object's: blue-red. */}
        <pattern id={stripesId} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={3} height={6} fill={OWN} />
          <rect x={3} width={3} height={6} fill={BAR_OVER} />
        </pattern>
      </defs>
      {gridValues.map((value) => (
        <line key={value} x1={0} x2={plotWidth} y1={toY(value)} y2={toY(value)} stroke={GRID} />
      ))}
      <line x1={0} x2={plotWidth} y1={PLOT_BOTTOM} y2={PLOT_BOTTOM} stroke="var(--progeo-track)" />
      {columns.map((sensor, index) => (
        <ThresholdMixerColumn
          key={sensor.sensor_order}
          sensor={sensor}
          x={index * column}
          column={column}
          labelled={index % every === 0}
          state={state}
          hovered={hovered === sensor.sensor_order}
          toY={toY}
          stripesId={stripesId}
          testId={testId}
        />
      ))}
      {/* Over the columns, so it reads as one line across the desk. */}
      {objectThreshold != null && (
        <line
          x1={0}
          x2={plotWidth}
          y1={toY(objectThreshold)}
          y2={toY(objectThreshold)}
          stroke={OBJECT_LINE}
          strokeWidth={2}
          pointerEvents="none"
        />
      )}
    </svg>
  );
};

export default ThresholdMixerPlot;
