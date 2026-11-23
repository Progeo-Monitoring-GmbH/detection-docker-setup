/**
 * The panel of "Repair order" under the plan canvas (ImageCanvasStage,
 * sensorOrderRepair.ts): the button that starts it, then its tools, the
 * progress, the Klemmliste check of the lines drawn and storing.
 */
import { ProgressBar } from 'react-bootstrap';
import { childTestId } from '../../testIds';
import PillButton from './kit/PillButton';
import SegmentedControl from './kit/SegmentedControl';
import type { RepairTool } from './sensorOrderRepair';
import type { SensorOrderRepair } from './useSensorOrderRepair';
import './SensorRepairPanel.css';

const TOOLS: Array<{ value: RepairTool; label: string; hotkey: string; title: string }> = [
  { value: 'area', label: 'Area', hotkey: 'A', title: 'Drag around the points to number again - Shift adds an area, Alt / Ctrl takes points out' },
  { value: 'click', label: 'Click', hotkey: 'C', title: 'Click the points one by one' },
  { value: 'line', label: 'Line', hotkey: 'L', title: 'Two clicks: every point along the line, from the first click on' },
  { value: 'swap', label: 'Swap', hotkey: 'S', title: 'Click two points to exchange their numbers' },
];

/** What the tool in use does - the badge on the plan and the hint here. */
export const repairHint = (repair: Pick<SensorOrderRepair, 'tool' | 'lineStart' | 'swapFirst' | 'result'>) => {
  if (!repair.result.total && repair.tool !== 'swap') {
    return 'Drag around the points to number again - Shift + drag adds another area.';
  }
  switch (repair.tool) {
    case 'area':
      return 'Drag a new area · Shift + drag adds one · Alt / Ctrl + drag takes points out';
    case 'click':
      return 'Click the gray points one by one - each gets the next number.';
    case 'line':
      return repair.lineStart
        ? 'Click the end of the line - the points along it get the next numbers · Esc cancels'
        : 'Click the start of a line (best on its first point).';
    default:
      return repair.swapFirst != null
        ? 'Click the second point - they exchange their numbers · Esc cancels'
        : 'Click two points to exchange their numbers.';
  }
};

const KlemmlisteCheck = ({ repair, testId }: { repair: SensorOrderRepair; testId?: string }) => {
  if (!repair.result.total) {
    return null;
  }
  if (!repair.klemmliste) {
    return (
      <div className="image-canvas-muted" data-testid={childTestId(testId, 'check-off')}>
        Klemmliste check off: the points of the area carry no Klemmliste names
        (“Messpunkt-MPLE”, e.g. A11-3) - apply the Klemmliste (step 8) first to
        get it.
      </div>
    );
  }
  const warnings = repair.verdicts.filter((verdict) => !verdict.ok).length;
  return (
    <div className="sensor-repair-check" data-testid={childTestId(testId, 'check')}>
      <div className="sensor-repair-check-title">
        Klemmliste check · <b>{repair.verdicts.length}</b> line(s) · <b>{repair.verdicts.length - warnings}</b> ok
        {warnings > 0 && (
          <>
            {' '}
            · <b className="sensor-repair-warn-text">{warnings}</b> warning(s)
          </>
        )}
      </div>
      {repair.verdicts.map((verdict, index) => (
        <div
          // Lines only come and go at the end (undo).
          key={index}
          className={`sensor-repair-check-row ${verdict.ok ? 'sensor-repair-check-row--ok' : 'sensor-repair-check-row--warn'}`}
          data-testid={childTestId(testId, 'check-row')}
        >
          {verdict.ok ? '✓' : '⚠'} Line {index + 1}: {verdict.text}
        </div>
      ))}
      {repair.open.length > 0 && (
        <div className="image-canvas-muted" data-testid={childTestId(testId, 'check-open')}>
          No line yet for MPLE <b>{repair.open.join(', ')}</b>
        </div>
      )}
    </div>
  );
};

/** "Repair order": the button - or, while on, its panel. */
const SensorRepairPanel = ({ repair, canRepair, testId }: { repair: SensorOrderRepair; canRepair: boolean; testId: string }) => {
  const panelId = childTestId(testId, 'repair');
  if (!canRepair) {
    return null;
  }
  if (!repair.active) {
    return (
      <div className="d-flex align-items-center gap-2 flex-wrap">
        <PillButton
          variant="surface"
          label="Repair order"
          title="Number the sensors of a broken stretch again by hand - areas, lines, clicks"
          onClick={repair.start}
          testId={childTestId(panelId, 'start')}
        />
        <span className="image-canvas-muted">Numbers wrong on part of the plan? Number them again by hand.</span>
      </div>
    );
  }
  const { result } = repair;
  const percent = result.total ? Math.round((result.done / result.total) * 100) : 0;
  const nextName = result.next != null ? repair.klemmliste?.names.get(result.next) : undefined;
  return (
    <div className="sensor-repair-panel d-flex flex-column gap-2" data-testid={panelId}>
      <div className="d-flex align-items-center gap-2 flex-wrap">
        <span className="image-canvas-action-title">Repair order</span>
        <SegmentedControl
          options={TOOLS}
          value={repair.tool}
          onChange={(value) => repair.pickTool(value as RepairTool)}
          testId={childTestId(panelId, 'tool')}
        />
        <PillButton
          variant="ghost"
          label="Undo (Z)"
          disabled={!repair.actions.length || repair.busy}
          onClick={repair.undo}
          testId={childTestId(panelId, 'undo')}
        />
      </div>

      <div className="d-flex align-items-center gap-2 flex-wrap" data-testid={childTestId(panelId, 'progress')}>
        <ProgressBar
          className="sensor-repair-progress"
          now={percent}
          variant={percent === 100 ? 'success' : undefined}
          aria-label="Numbered"
        />
        <span>
          {result.total ? (
            <>
              <b>{result.done}</b> / <b>{result.total}</b> numbered (<b>{percent} %</b>)
              {result.boxes.length > 1 && <> · {result.boxes.length} areas</>}
              {result.next != null && (
                <>
                  {' '}
                  · next <b>{result.next}</b>
                  {nextName ? <> {nextName}</> : null}
                </>
              )}
            </>
          ) : (
            'No area selected yet'
          )}
        </span>
      </div>

      <div className="image-canvas-muted">{repairHint(repair)}</div>

      <KlemmlisteCheck repair={repair} testId={panelId} />

      {repair.error && (
        <div role="alert" className="image-canvas-action image-canvas-action--error" data-testid={childTestId(panelId, 'error')}>
          {repair.error}
        </div>
      )}

      <div className="d-flex align-items-center gap-2 flex-wrap">
        <PillButton
          variant="accent"
          label={repair.busy ? 'Saving…' : 'Save order'}
          disabled={repair.problem != null || repair.busy}
          onClick={repair.store}
          testId={childTestId(panelId, 'save')}
        />
        <PillButton
          variant="ghost"
          label="Discard"
          disabled={repair.busy}
          onClick={repair.leave}
          testId={childTestId(panelId, 'discard')}
        />
        {repair.problem && (
          <span className="image-canvas-muted" data-testid={childTestId(panelId, 'problem')}>
            {repair.problem}
          </span>
        )}
      </div>
    </div>
  );
};

export default SensorRepairPanel;
