import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { heatColorTable } from './heatmapCanvas';
import {
  chartFrame,
  chartLayout,
  frameWeights,
  heatReference,
  locationThreshold,
  plotSensors,
  seriesPeak,
  type PlotSensor,
} from './heatmapChart';
import { heatFieldCanvas, type Scene } from './heatmapScene';
import {
  fieldScaleOf,
  heatNormalization,
  scaleTitle,
  sensorTexter,
  thresholdMarks,
  tickLabeler,
} from './heatmapScale';
import { limitPolygons } from './heatLimitations';
import {
  placeSuspicionMarkers,
  type SuspicionPlanMarker,
} from './SuspicionMarkers';
import type {
  HeatProfile,
  SensorHeatmapLageplanData,
  SensorHeatmapLocation,
  SensorHeatmapResponse,
} from './sensorHeatmapTypes';

/** What SensorHeatmap2D draws besides the heat (its floating controls). */
export type HeatmapDisplay = {
  showDots: boolean;
  showLabels: boolean;
  showLines: boolean;
  /** Staff: the absolute scale (to the period's highest value). */
  normalize: boolean;
};

/**
 * What is drawn (the floating controls): the dots, their labels (off by
 * default - field mode names devices, so there they start on), the dm band
 * lines and - staff - the absolute scale; and the area selection mode (a
 * drag selects instead of moving the plan).
 */
export const useHeatmapDisplay = (fieldMode: boolean) => {
  const [showDots, setShowDots] = useState(true);
  const [showLabels, setShowLabels] = useState(fieldMode);
  const [showLines, setShowLines] = useState(true);
  const [normalize, setNormalize] = useState(false);
  const [areaMode, setAreaMode] = useState(false);
  return {
    showDots,
    setShowDots,
    showLabels,
    setShowLabels,
    showLines,
    setShowLines,
    normalize,
    setNormalize,
    areaMode,
    setAreaMode,
  };
};

export type HeatmapDisplayState = ReturnType<typeof useHeatmapDisplay>;

/**
 * The heat's scale: normalized (see heatNormalization) the period's highest
 * reading saturates the field (frames stay comparable); else a multiple of
 * the alarm threshold. Normalized is the absolute scale (`absoluteScale`):
 * its ticks are readings (mV), and the alarm threshold (|WP - EP| only) is
 * marked on it - values above it stay apart instead of all being full red.
 */
const useHeatScale = ({
  sensors,
  location,
  fieldMode,
  normalize,
  profile,
  forceNormalize,
}: {
  sensors: PlotSensor[];
  location: SensorHeatmapLocation | null;
  fieldMode: boolean;
  normalize: boolean;
  profile: HeatProfile;
  forceNormalize: boolean;
}) => {
  const { forced: normalizeForced, normalized } = heatNormalization({
    fieldMode,
    normalize,
    profile,
    forceNormalize,
  });
  const heatScale = useMemo(
    () => (normalized ? seriesPeak(sensors) : heatReference(location)),
    [normalized, sensors, location],
  );
  const absoluteScale = normalized && heatScale != null ? heatScale : null;
  const scaleMarks = useMemo(
    () =>
      thresholdMarks({
        absoluteScale,
        threshold: locationThreshold(location),
        profile,
        forceNormalize,
      }),
    [absoluteScale, forceNormalize, location, profile],
  );
  return { heatScale, absoluteScale, normalizeForced, scaleMarks };
};

/**
 * The scene SensorHeatmap2D draws (heatmapScene.ts) for the shown frame:
 * the sensors on the plan (the same for every frame - only the heat field
 * follows the slider), the heat field, its colour scale and the plan's heat
 * limitations. Null without sensors or frames.
 */
export const useHeatmapScene = ({
  response,
  location,
  activePlan,
  image,
  resolution,
  fitPlan,
  field,
  sigma,
  frameIndex,
  frameCount,
  profile,
  forceNormalize,
  heatTitle,
  display,
  suspicions,
}: {
  response: SensorHeatmapResponse | null | undefined;
  location: SensorHeatmapLocation | null;
  activePlan: SensorHeatmapLageplanData | null;
  image: HTMLImageElement | null;
  resolution: number;
  fitPlan: boolean;
  field: { unit: string; decimals?: number } | undefined;
  sigma: 'auto' | number;
  frameIndex: number;
  frameCount: number;
  profile: HeatProfile;
  forceNormalize: boolean;
  heatTitle: string | undefined;
  display: HeatmapDisplay;
  suspicions: SuspicionPlanMarker[] | undefined;
}) => {
  const { t } = useTranslation();
  // Primitives, so a new `field` object per render doesn't recompute.
  const fieldUnit = field?.unit ?? null;
  const fieldDecimals = field?.decimals ?? 1;
  const fieldMode = fieldUnit != null;
  const imageSize = useMemo(
    () =>
      image ? { width: image.naturalWidth, height: image.naturalHeight } : null,
    [image],
  );

  const flipY = Boolean(location?.flip_y);
  const sensors = useMemo(
    () => plotSensors(response, flipY),
    [response, flipY],
  );
  // Field mode: one colour scale for every frame, so the frames compare.
  const fieldScale = useMemo(
    () => fieldScaleOf(sensors, fieldUnit, fieldDecimals),
    [fieldUnit, fieldDecimals, sensors],
  );
  const layout = useMemo(
    () =>
      chartLayout({
        sensors,
        resolution,
        location,
        imageSize,
        fitPlan,
        fieldMode,
      }),
    [sensors, resolution, location, imageSize, fitPlan, fieldMode],
  );

  const { heatScale, absoluteScale, normalizeForced, scaleMarks } =
    useHeatScale({
      sensors,
      location,
      fieldMode,
      normalize: display.normalize,
      profile,
      forceNormalize,
    });
  const frame = useMemo(
    () =>
      layout && frameCount > 0
        ? chartFrame(layout, frameWeights(sensors, frameIndex, fieldMode), {
            sigma,
            heatReference: heatScale,
            fieldRange: fieldScale?.range ?? null,
          })
        : null,
    [
      layout,
      frameCount,
      sensors,
      frameIndex,
      fieldMode,
      sigma,
      heatScale,
      fieldScale,
    ],
  );
  const hasLines = Boolean(layout?.lines.some((line) => line != null));
  // mx-PEEL: the computed suspicion points on the plan (same alignment as the sensors).
  const placedSuspicions = useMemo(
    () =>
      layout
        ? placeSuspicionMarkers(
            suspicions,
            location,
            imageSize,
            flipY,
            layout.world,
          )
        : [],
    [suspicions, layout, location, imageSize, flipY],
  );

  const colorTable = useMemo(() => heatColorTable(), []);
  const heatCanvas = useMemo(
    () => (frame ? heatFieldCanvas(frame, colorTable) : null),
    [frame, colorTable],
  );
  // Only on the plan image - without one the areas have nothing to refer to.
  const planAreas = activePlan?.heat_limitations;
  const limits = useMemo(
    () => (layout && image ? limitPolygons(planAreas, layout.world) : []),
    [layout, image, planAreas],
  );

  const { showDots, showLabels, showLines } = display;
  const scene = useMemo<Scene | null>(
    () =>
      layout && frame
        ? {
            layout,
            frame,
            image,
            heatCanvas,
            colorTable,
            sensorText: sensorTexter(layout, fieldMode),
            scaleTitle: scaleTitle({
              fieldScale,
              heatTitle,
              profile,
              absoluteScale,
              t,
            }),
            tickLabel: tickLabeler(fieldScale, absoluteScale),
            scaleMarks,
            limits,
            showSensors: showDots,
            showLabels,
            showLines: hasLines && showLines,
          }
        : null,
    [
      layout,
      frame,
      image,
      heatCanvas,
      colorTable,
      fieldMode,
      fieldScale,
      t,
      limits,
      profile,
      heatTitle,
      absoluteScale,
      scaleMarks,
      showDots,
      showLabels,
      hasLines,
      showLines,
    ],
  );

  return {
    scene,
    frame,
    imageSize,
    placedSuspicions,
    fieldMode,
    fieldScale,
    absoluteScale,
    normalizeForced,
    hasLines,
    colorTable,
  };
};
