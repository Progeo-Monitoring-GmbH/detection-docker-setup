/**
 * The scale panel under the plan canvas of ImageCanvasStage: the reference
 * point (R), the calibration from two points of a known distance (M) and
 * meters per pixel. Styles in ImageCanvasStage.css.
 */
import { childTestId } from '../../testIds';
import type { ImagePoint } from './imageCanvasGeometry';
import type { CanvasTool } from './imageCanvasModes';

const toolClass = (active: boolean) => `image-canvas-pill btn btn-sm ${active ? 'btn-primary' : 'btn-outline-primary'}`;

const referenceText = (tool: CanvasTool, point: ImagePoint | null) => {
  if (tool === 'reference') {
    return 'Click the reference point on the plan.';
  }
  return point ? `at pixel (${Math.round(point[0])}, ${Math.round(point[1])})` : 'not set';
};

const ReferenceRow = ({
  tool,
  referencePoint,
  onToggle,
  testId,
}: {
  tool: CanvasTool;
  referencePoint: ImagePoint | null;
  onToggle: () => void;
  testId: string;
}) => (
  <div className="d-flex flex-wrap align-items-center gap-2">
    <button
      type="button"
      className={toolClass(tool === 'reference')}
      onClick={onToggle}
      data-testid={childTestId(testId, 'reference-point')}
    >
      Reference point
    </button>
    <span className="image-canvas-muted">{referenceText(tool, referencePoint)}</span>
    {tool !== 'reference' && (
      <span className="image-canvas-muted d-flex align-items-center gap-1">
        · or hold <kbd className="canvas-key-badge">R</kbd> and click
      </span>
    )}
  </div>
);

const CalibrationRow = ({
  tool,
  pointCount,
  pixels,
  meters,
  onMeters,
  onToggle,
  testId,
}: {
  tool: CanvasTool;
  pointCount: number;
  pixels: number | null;
  meters: string;
  onMeters: (value: string) => void;
  onToggle: () => void;
  testId: string;
}) => (
  <div className="d-flex flex-wrap align-items-center gap-2">
    <button
      type="button"
      className={toolClass(tool === 'calibrate')}
      onClick={onToggle}
      data-testid={childTestId(testId, 'calibrate')}
    >
      Calibrate
    </button>
    {pixels == null ? (
      <span className="image-canvas-muted d-flex align-items-center gap-1">
        Hold <kbd className="canvas-key-badge">M</kbd> and click two points with a known distance
        {tool === 'calibrate' ? ` (${pointCount}/2)` : ''}.
      </span>
    ) : (
      <>
        <span className="image-canvas-muted">{pixels.toFixed(1)} px =</span>
        <input
          type="number"
          className="image-canvas-field image-canvas-field--distance form-control form-control-sm"
          min="0"
          step="0.01"
          placeholder="meters"
          aria-label="Distance in meters"
          value={meters}
          onChange={(event) => onMeters(event.target.value)}
          data-testid={childTestId(testId, 'calibration-meters')}
        />
        <span className="image-canvas-muted">m</span>
      </>
    )}
  </div>
);

export const ScalePanel = ({
  tool,
  referencePoint,
  onToggleReference,
  calibrationCount,
  calibrationPixels,
  calibrationMeters,
  onCalibrationMeters,
  onToggleCalibrate,
  metersPerPixel,
  onMetersPerPixel,
  dirty,
  testId,
}: {
  tool: CanvasTool;
  referencePoint: ImagePoint | null;
  onToggleReference: () => void;
  calibrationCount: number;
  calibrationPixels: number | null;
  calibrationMeters: string;
  onCalibrationMeters: (value: string) => void;
  onToggleCalibrate: () => void;
  metersPerPixel: string;
  onMetersPerPixel: (value: string) => void;
  dirty: boolean;
  testId: string;
}) => (
  <div className="image-canvas-sub-panel" data-testid={childTestId(testId, 'scale')}>
    <div>
      <div className="image-canvas-sub-title">Scale</div>
      <div className="image-canvas-muted">
        Positions in meters: x to the right, y up from the reference
        point.
      </div>
    </div>

    <ReferenceRow tool={tool} referencePoint={referencePoint} onToggle={onToggleReference} testId={testId} />

    <CalibrationRow
      tool={tool}
      pointCount={calibrationCount}
      pixels={calibrationPixels}
      meters={calibrationMeters}
      onMeters={onCalibrationMeters}
      onToggle={onToggleCalibrate}
      testId={testId}
    />

    <div className="d-flex flex-wrap align-items-center gap-2">
      <label className="image-canvas-muted mb-0" htmlFor="meters-per-pixel">
        Meters per pixel
      </label>
      <input
        id="meters-per-pixel"
        type="number"
        className="image-canvas-field image-canvas-field--scale form-control form-control-sm"
        min="0"
        step="any"
        value={metersPerPixel}
        onChange={(event) => onMetersPerPixel(event.target.value)}
        data-testid={childTestId(testId, 'meters-per-pixel')}
      />
      {dirty && <span className="image-canvas-muted ms-auto">Not stored yet - see the bar at the bottom.</span>}
    </div>
  </div>
);
