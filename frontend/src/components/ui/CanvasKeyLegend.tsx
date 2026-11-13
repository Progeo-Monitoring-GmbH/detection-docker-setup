/**
 * The legend under a plan canvas (ImageCanvasStage): what the mouse and the
 * keys do, in groups - the action in use (a held key, an edit mode) is
 * highlighted.
 */
import { childTestId } from '../../testIds';
import './CanvasKeyLegend.css';

const MOUSE_ACTIONS = new Set(['Drag', 'Click', 'Scroll', 'Hover']);

export type LegendEntry = {
  /** Pressed together, e.g. ['Ctrl', 'Scroll'] - mouse actions get their own look. */
  keys: string[];
  label: string;
  active?: boolean;
};

export type LegendGroup = {
  title: string;
  entries: Array<LegendEntry | false | null | undefined>;
  /** A line under the group. */
  note?: string;
};

const CanvasKeyLegend = ({
  groups,
  testId = 'canvas-key-legend',
}: {
  groups: Array<LegendGroup | false | null | undefined>;
  /** data-testid of the legend; its groups are "<testId>-group" (key: the group's title). */
  testId?: string;
}) => {
  const shown = groups
    .filter((group): group is LegendGroup => Boolean(group))
    .map((group) => ({ ...group, entries: group.entries.filter((entry): entry is LegendEntry => Boolean(entry)) }))
    .filter((group) => group.entries.length > 0);
  if (!shown.length) {
    return null;
  }
  return (
    <div
      aria-label="Mouse and keyboard"
      className="canvas-key-legend"
      data-testid={testId}
    >
      {shown.map((group) => (
        <section
          key={group.title}
          className="d-flex flex-column gap-1"
          data-testid={childTestId(testId, 'group')}
          data-test-key={group.title}
        >
          <h6 className="mb-1 canvas-key-legend-title">
            {group.title}
          </h6>
          {group.entries.map((entry) => (
            <div
              key={`${entry.keys.join('+')} ${entry.label}`}
              className={`d-flex align-items-center gap-3 canvas-key-legend-entry${
                entry.active ? ' canvas-key-legend-entry--active' : ''
              }`}
            >
              <span className="d-inline-flex align-items-center gap-1 flex-shrink-0 canvas-key-legend-keys">
                {entry.keys.map((key, index) => (
                  <span key={key} className="d-inline-flex align-items-center gap-1">
                    {index > 0 && <span className="canvas-key-legend-plus">+</span>}
                    <kbd className={MOUSE_ACTIONS.has(key) ? 'canvas-key-badge canvas-key-badge--mouse' : 'canvas-key-badge'}>
                      {key}
                    </kbd>
                  </span>
                ))}
              </span>
              <span>{entry.label}</span>
            </div>
          ))}
          {group.note && <div className="canvas-key-legend-note">{group.note}</div>}
        </section>
      ))}
    </div>
  );
};

export default CanvasKeyLegend;
