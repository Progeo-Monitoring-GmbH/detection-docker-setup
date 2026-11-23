import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from 'react-bootstrap';
import FrameSlider, { type AlarmSpan } from './FrameSlider';
import type { ChartSensor } from './heatmapChart';
import { areaRectBox } from './heatmapMarkers';
import { heatReadout, readingColor, type FieldScale } from './heatmapScale';
import HeatmapDisplayControls from './HeatmapDisplayControls';
import HeatmapToolbar from './HeatmapToolbar';
import { formatMeters } from './planMeters';
import SensorTooltip from './SensorTooltip';
import type {
  HeatProfile,
  SensorHeatmapLageplanData,
} from './sensorHeatmapTypes';
import type { useHeatmapFrameExport } from './useHeatmapFrameExport';
import type { HeatmapDisplayState } from './useHeatmapScene';
import { type Hover, underCursorOf } from './useHeatmapPointer';
import type { AreaRect } from './useHeatmapViewport';
import type { View } from './heatmapCanvas';
import type { Scene } from './heatmapScene';
import SuspicionMarkersOverlay, {
  type PlacedSuspicionMarker,
} from './SuspicionMarkers';
import { childTestId } from '../../testIds';

/** The parts of SensorHeatmap2D around and over its canvas. */

export const DEFAULT_HEATMAP_TEST_ID = 'sensor-heatmap';

/** The test ids of the parts with an id of their own: they keep it while the
 * heatmap has the default id, else they are scoped under the heatmap's. */
export const ownPartTestIds = (testId: string) =>
  testId === DEFAULT_HEATMAP_TEST_ID
    ? { areaRect: 'heatmap-area-rect', display: undefined }
    : {
        areaRect: childTestId(testId, 'area-rect'),
        display: childTestId(testId, 'display'),
      };

type VideoExport = ReturnType<typeof useHeatmapFrameExport>;

/** Whether the toolbar gets a row of its own: with more than the video export
 * (page controls, the Lageplan switcher, σ) or without the slider - else the
 * export sits at the right end of the slider's row. */
export const toolbarHasOwnRow = ({
  hideFrameSlider,
  hasStart,
  sigmaEditable,
  planCount,
}: {
  hideFrameSlider: boolean;
  hasStart: boolean;
  sigmaEditable: boolean;
  planCount: number;
}) => hideFrameSlider || hasStart || sigmaEditable || planCount > 1;

/** Above the plot: the toolbar (Lageplan switcher, σ, video export) and the
 * frame slider - then the video export's error, if any. */
export const HeatmapHeader = ({
  toolbarStart,
  plans,
  planIndex,
  onPlanChange,
  sigma,
  videoExport,
  timestamps,
  frameIndex,
  onFrameChange,
  hideFrameSlider,
  alarms,
  frameToolbar,
  testId,
}: {
  toolbarStart: ReactNode;
  /** The Lageplans to switch between; null: no switcher. */
  plans: SensorHeatmapLageplanData[] | null;
  planIndex: number;
  onPlanChange: (index: number) => void;
  /** Staff: the kernel width and its change. */
  sigma:
    | { value: 'auto' | number; onChange: (sigma: 'auto' | number) => void }
    | undefined;
  videoExport: VideoExport;
  timestamps: number[];
  frameIndex: number;
  onFrameChange: (index: number) => void;
  hideFrameSlider: boolean;
  alarms: AlarmSpan[] | undefined;
  frameToolbar: ReactNode;
  testId: string;
}) => {
  const ownRow = toolbarHasOwnRow({
    hideFrameSlider,
    hasStart: Boolean(toolbarStart),
    sigmaEditable: sigma != null,
    planCount: plans?.length ?? 0,
  });
  const toolbar = (
    <HeatmapToolbar
      start={toolbarStart}
      plans={plans}
      planIndex={planIndex}
      onPlanChange={onPlanChange}
      sigma={sigma}
      testId={childTestId(testId, 'toolbar')}
      video={{
        exporting: videoExport.videoExporting,
        stage: videoExport.videoStage,
        progress: videoExport.videoProgress,
        resultUrl: videoExport.videoResultUrl,
        download: videoExport.downloadVideoResult,
        start: videoExport.exportFrames,
        enabled: timestamps.length >= 2,
      }}
    />
  );
  return (
    <>
      <div className="px-2 pt-2">
        {ownRow && toolbar}
        {!hideFrameSlider && (
          <div className="pb-1">
            <FrameSlider
              id="heatmap2d-timestamp"
              timestamps={timestamps}
              index={frameIndex}
              onChange={onFrameChange}
              disabled={videoExport.videoExporting}
              alarms={alarms}
              toolbar={frameToolbar}
              end={ownRow ? null : toolbar}
              testId={childTestId(testId, 'frame-slider')}
            />
          </div>
        )}
      </div>

      {videoExport.videoError && (
        <div
          className="text-danger small mb-2 px-2"
          data-testid={childTestId(testId, 'video-error')}
        >
          {videoExport.videoError}
        </div>
      )}
    </>
  );
};

/** Where the plot goes while its plan image loads - as tall as the last plot. */
export const PlotPlaceholder = ({
  height,
  testId,
}: {
  height: number;
  testId: string | undefined;
}) => {
  const { t } = useTranslation();
  return (
    <div
      className="heatmap2d-plot-placeholder text-muted"
      style={{ height }}
      data-testid={testId}
    >
      <Spinner animation="border" size="sm" className="me-2" />
      {t('ui_loading')}
    </div>
  );
};

/** Over everything of the plot while the parent loads other data: it takes
 * no input until the new data is there. */
const PlotBusyOverlay = ({ testId }: { testId: string | undefined }) => {
  const { t } = useTranslation();
  return (
    <div className="heatmap2d-busy" data-testid={testId}>
      <Spinner animation="border" className="me-2" />
      {t('ui_loading')}
    </div>
  );
};

/** Under the controls: the area being dragged (area selection) and the
 * suspicion points (mx-PEEL). */
export const PlotMarks = ({
  areaRect,
  suspicions,
  view,
  width,
  height,
  areaRectTestId,
}: {
  areaRect: AreaRect | null;
  suspicions: PlacedSuspicionMarker[];
  view: View | null;
  width: number;
  height: number;
  areaRectTestId: string | undefined;
}) => (
  <>
    {areaRect && (
      <div
        data-testid={areaRectTestId}
        className="heatmap2d-area-rect"
        style={areaRectBox(areaRect)}
      />
    )}
    {view && suspicions.length > 0 && (
      <SuspicionMarkersOverlay
        markers={suspicions}
        view={view}
        width={width}
        height={height}
      />
    )}
  </>
);

/**
 * The floating display controls of the plot: dots, labels, the area
 * selection (with `areaSelectable`), dm band lines (with `hasLines`) and -
 * staff, not in field mode - the sensor names (with `hasNames`), the
 * absolute scale and the profile (with `onProfileChange`).
 */
export const PlotDisplayControls = ({
  state,
  areaSelectable,
  hasLines,
  hasNames,
  heatOptions,
  normalizeForced,
  profile,
  onProfileChange,
  profileLoading,
  testId,
}: {
  state: HeatmapDisplayState;
  areaSelectable: boolean;
  hasLines: boolean;
  /** Some sensor has a name (ProgeoMeasurePoint.name). */
  hasNames: boolean;
  /** Staff outside field mode: the names, scale and profile are offered. */
  heatOptions: boolean;
  normalizeForced: boolean;
  profile: HeatProfile;
  onProfileChange: ((profile: HeatProfile) => void) | undefined;
  profileLoading: boolean;
  testId: string | undefined;
}) => (
  <HeatmapDisplayControls
    dots={{ value: state.showDots, onChange: state.setShowDots }}
    labels={{ value: state.showLabels, onChange: state.setShowLabels }}
    area={
      areaSelectable
        ? { value: state.areaMode, onChange: state.setAreaMode }
        : null
    }
    lines={
      hasLines ? { value: state.showLines, onChange: state.setShowLines } : null
    }
    names={
      heatOptions && hasNames
        ? { value: state.showNames, onChange: state.setShowNames }
        : null
    }
    normalize={
      heatOptions
        ? {
            value: state.normalize,
            onChange: state.setNormalize,
            forced: normalizeForced,
          }
        : null
    }
    profile={
      heatOptions && onProfileChange
        ? { value: profile, onChange: onProfileChange, loading: profileLoading }
        : null
    }
    testId={testId}
  />
);

/** The tooltip of the hovered sensor, titled with its name (e.g. "A2-15"
 * from the Klemmliste) - in field mode the sensors are devices, named as in
 * the climate charts, with the reading's colour. */
const HoveredSensorTooltip = ({
  sensor,
  value,
  meters,
  screen,
  fieldScale,
  colorTable,
  containerWidth,
  containerHeight,
  testId,
}: {
  sensor: ChartSensor;
  value: number;
  meters: [number, number] | null;
  screen: [number, number];
  fieldScale: FieldScale | null;
  colorTable: Uint8ClampedArray;
  containerWidth: number;
  containerHeight: number;
  testId?: string;
}) => (
  <SensorTooltip
    sensorPos={sensor.pos}
    name={fieldScale ? (sensor.label ?? sensor.name) : sensor.name}
    meters={meters}
    value={value}
    unit={fieldScale?.unit}
    decimals={fieldScale?.decimals}
    dotColor={readingColor(colorTable, fieldScale?.range, value)}
    threshold={sensor.threshold}
    disabled={Boolean(sensor.disabled)}
    cursorX={screen[0]}
    cursorY={screen[1]}
    containerWidth={containerWidth}
    containerHeight={containerHeight}
    testId={testId}
  />
);

/** Position in meters and heat (field mode: the reading) under the cursor,
 * bottom left on the plan. */
const CursorReadout = ({
  meters,
  heat,
  fieldScale,
  absoluteScale = null,
  testId,
}: {
  meters: [number, number] | null;
  heat: number | null;
  fieldScale: FieldScale | null;
  /** Staff's absolute scale: the reading (mV) of a heat of 1. */
  absoluteScale?: number | null;
  testId?: string;
}) => {
  const { t } = useTranslation();
  return (
    <div className="heatmap2d-readout small" data-testid={testId}>
      {[
        meters ? formatMeters(meters) : null,
        heat == null
          ? null
          : heatReadout(heat, { fieldScale, absoluteScale, t }),
      ]
        .filter(Boolean)
        .join(' · ')}
    </div>
  );
};

/** Over the controls: the hovered sensor's tooltip, the readout of the plan
 * under the cursor and - while the parent loads (`busy`) - the dimming. */
export const PlotPointerOverlays = ({
  scene,
  hover,
  hoveredIndex,
  fieldScale,
  absoluteScale,
  colorTable,
  width,
  height,
  busy,
  testId,
}: {
  scene: Scene;
  hover: Hover | null;
  /** Index (into the layout's sensors) of the hovered sensor. */
  hoveredIndex: number | null;
  fieldScale: FieldScale | null;
  absoluteScale: number | null;
  colorTable: Uint8ClampedArray;
  width: number;
  height: number;
  busy: boolean;
  testId: string;
}) => {
  const underCursor = underCursorOf(hover);
  return (
    <>
      {hover?.kind === 'sensor' && hoveredIndex != null && (
        <HoveredSensorTooltip
          sensor={scene.layout.sensors[hoveredIndex]}
          value={scene.frame.values[hoveredIndex]}
          meters={hover.meters}
          screen={hover.screen}
          fieldScale={fieldScale}
          colorTable={colorTable}
          containerWidth={width}
          containerHeight={height}
          testId={childTestId(testId, 'sensor-tooltip')}
        />
      )}

      {underCursor && (
        <CursorReadout
          meters={underCursor.meters}
          heat={underCursor.heat}
          fieldScale={fieldScale}
          absoluteScale={absoluteScale}
          testId={childTestId(testId, 'readout')}
        />
      )}

      {busy && <PlotBusyOverlay testId={childTestId(testId, 'busy')} />}
    </>
  );
};
