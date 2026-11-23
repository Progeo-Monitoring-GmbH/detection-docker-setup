import { seriesRange } from './heatmapGrid';
import { heatColorAt } from './heatmapCanvas';
import {
  absoluteTick,
  type ChartLayout,
  type FieldRange,
  type PlotSensor,
} from './heatmapChart';
import type { HeatProfile } from './sensorHeatmapTypes';

/**
 * The colour scale of SensorHeatmap2D and how values on it read: heat
 * (0..1 of a multiple of the alarm threshold), staff's absolute scale (the
 * period's peak reading) or - field mode - readings with their unit on a
 * min-max scale over all frames.
 */

type Translate = (key: string) => string;

/** Field mode: the colour scale (over all frames) and how readings show. */
export type FieldScale = { range: FieldRange; unit: string; decimals: number };

/** Field mode: the reading a grid value (0..1 of the scale) stands for. */
export const fieldReading = ({ range }: FieldScale, heat: number) =>
  range.min + heat * (range.max - range.min);

/** Field mode: a reading with its unit, e.g. "54.3 %". */
export const formatReading = ({ decimals, unit }: FieldScale, value: number) =>
  `${value.toFixed(decimals)} ${unit}`.trim();

/** Field mode (a unit): one colour scale over the readings of every frame, so
 * the frames compare - padded to at least one step of the last decimal. */
export const fieldScaleOf = (
  sensors: PlotSensor[],
  unit: string | null,
  decimals: number,
): FieldScale | null =>
  unit != null
    ? {
        unit,
        decimals,
        range: seriesRange(
          sensors.map((sensor) => sensor.series),
          10 ** (1 - decimals),
        ) ?? { min: 0, max: 1 },
      }
    : null;

/**
 * Whether the heat is normalized: WP, EP and WP + EP have no threshold to
 * scale against (`forced`, like `forceNormalize`); staff may pick it for
 * |WP - EP|. Never in field mode, which has its own scale.
 */
export const heatNormalization = ({
  fieldMode,
  normalize,
  profile,
  forceNormalize,
}: {
  fieldMode: boolean;
  normalize: boolean;
  profile: HeatProfile;
  forceNormalize: boolean;
}) => {
  const forced = profile !== 'diff' || forceNormalize;
  return { forced, normalized: !fieldMode && (normalize || forced) };
};

/**
 * Marks on an absolute scale (0..1 of it): the alarm threshold - only for
 * |WP - EP|, the value it applies to. None on a relative scale.
 */
export const thresholdMarks = ({
  absoluteScale,
  threshold,
  profile,
  forceNormalize,
}: {
  absoluteScale: number | null;
  threshold: number | null;
  profile: HeatProfile;
  forceNormalize: boolean;
}) =>
  absoluteScale != null &&
  threshold != null &&
  profile === 'diff' &&
  !forceNormalize
    ? [threshold / absoluteScale]
    : [];

/** Title of the colour scale: the field's unit, the caller's title, the
 * profile's name, else the absolute scale's unit or "heat". */
export const scaleTitle = ({
  fieldScale,
  heatTitle,
  profile,
  absoluteScale,
  t,
}: {
  fieldScale: FieldScale | null;
  heatTitle: string | undefined;
  profile: HeatProfile;
  absoluteScale: number | null;
  t: Translate;
}) => {
  if (fieldScale) {
    return fieldScale.unit;
  }
  if (heatTitle != null) {
    return heatTitle;
  }
  if (profile !== 'diff') {
    return t(`heatmap_profile_${profile}`);
  }
  return absoluteScale != null ? t('heatmap_scale_unit') : t('heatmap_heat');
};

/** The label of a tick on the colour scale (0..1 of it). */
export const tickLabeler =
  (fieldScale: FieldScale | null, absoluteScale: number | null) =>
  (value: number): string => {
    if (fieldScale) {
      return fieldReading(fieldScale, value).toFixed(fieldScale.decimals);
    }
    if (absoluteScale != null) {
      return absoluteTick(value * absoluteScale);
    }
    return value.toFixed(1);
  };

/** The text next to a sensor's marker: in field mode the sensors are devices,
 * named like their lines in the climate charts; otherwise the sensor number -
 * with `names` (staff) its name ("A2-15"), the number when it has none. */
export const sensorTexter =
  (layout: ChartLayout, fieldMode: boolean, names = false) => (index: number) => {
    const sensor = layout.sensors[index];
    if (fieldMode) {
      return sensor.label ?? sensor.name ?? String(sensor.pos);
    }
    return names ? (sensor.name ?? String(sensor.pos)) : String(sensor.pos);
  };

/** The readout's text for a heat (0..1) under the cursor. */
export const heatReadout = (
  heat: number,
  {
    fieldScale,
    absoluteScale,
    t,
  }: {
    fieldScale: FieldScale | null;
    absoluteScale: number | null;
    t: Translate;
  },
) => {
  if (fieldScale) {
    return formatReading(fieldScale, fieldReading(fieldScale, heat));
  }
  if (absoluteScale != null) {
    return `${t('heatmap_heat')} ${absoluteTick(heat * absoluteScale)} ${t('heatmap_scale_unit')}`;
  }
  return `${t('heatmap_heat')} ${heat.toFixed(2)}`;
};

/** Field mode: the colour of a reading on the field's scale - none for a
 * flat (or no) range, the tooltip then uses its alarm colour. */
export const readingColor = (
  colorTable: Uint8ClampedArray,
  range: FieldRange | undefined,
  value: number,
) =>
  range && range.max > range.min
    ? heatColorAt(colorTable, (value - range.min) / (range.max - range.min))
    : undefined;
