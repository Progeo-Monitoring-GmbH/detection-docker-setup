/**
 * The legend over a plan canvas (ImageCanvasStage, HeatLimitationStage):
 * what the mouse and the keys do, in groups - the action in use (a held
 * key, an edit mode) is highlighted. It sticks to the top of the window
 * while the page scrolls and can be collapsed to its title line (which then
 * still names the action in use); collapsed or not is shared by every
 * legend and remembered in this browser.
 */
import { useSyncExternalStore } from 'react';
import { ChevronDown, ChevronUp, Keyboard } from 'react-bootstrap-icons';
import { childTestId } from '../../testIds';
import './CanvasKeyLegend.css';

const MOUSE_ACTIONS = new Set(['Drag', 'Click', 'Double-click', 'Scroll', 'Hover']);
const STORAGE_KEY = 'progeo.canvasKeyLegend.collapsed';

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

// Collapsed or not - one state for every legend on the page, kept in
// localStorage (a convenience: without it the legend starts open).
const listeners = new Set<() => void>();
const readCollapsed = () => {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};
let collapsed = typeof window !== 'undefined' && readCollapsed();
const setCollapsed = (next: boolean) => {
  collapsed = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // Private mode / blocked storage: only this page keeps it.
  }
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const Keys = ({ keys }: { keys: string[] }) => (
  <span className="d-inline-flex align-items-center gap-1 flex-shrink-0 canvas-key-legend-keys">
    {keys.map((key, index) => (
      <span key={key} className="d-inline-flex align-items-center gap-1">
        {index > 0 && <span className="canvas-key-legend-plus">+</span>}
        <kbd className={MOUSE_ACTIONS.has(key) ? 'canvas-key-badge canvas-key-badge--mouse' : 'canvas-key-badge'}>
          {key}
        </kbd>
      </span>
    ))}
  </span>
);

const CanvasKeyLegend = ({
  groups,
  sticky = true,
  testId = 'canvas-key-legend',
}: {
  groups: Array<LegendGroup | false | null | undefined>;
  /** Sticks to the top of the window while the page scrolls (default). */
  sticky?: boolean;
  /** data-testid of the legend; its groups are "<testId>-group" (key: the group's title), the toggle "<testId>-toggle". */
  testId?: string;
}) => {
  const isCollapsed = useSyncExternalStore(subscribe, () => collapsed, () => false);
  const shown = groups
    .filter((group): group is LegendGroup => Boolean(group))
    .map((group) => ({ ...group, entries: group.entries.filter((entry): entry is LegendEntry => Boolean(entry)) }))
    .filter((group) => group.entries.length > 0);
  if (!shown.length) {
    return null;
  }
  const active = shown.flatMap((group) => group.entries).find((entry) => entry.active);
  const bodyId = `${testId}-body`;

  return (
    <div
      aria-label="Mouse and keyboard"
      className={`canvas-key-legend-shell${sticky ? ' canvas-key-legend-shell--sticky' : ''}`}
      data-testid={testId}
      data-collapsed={isCollapsed || undefined}
    >
      <div className="canvas-key-legend-head">
        <Keyboard aria-hidden className="canvas-key-legend-head-icon" />
        <span className="canvas-key-legend-head-title">Mouse &amp; keys</span>
        {isCollapsed && active && (
          <span className="canvas-key-legend-head-active d-inline-flex align-items-center gap-2" data-testid={childTestId(testId, 'active')}>
            <Keys keys={active.keys} />
            <span>{active.label}</span>
          </span>
        )}
        <button
          type="button"
          className="canvas-key-legend-toggle ms-auto"
          aria-expanded={!isCollapsed}
          aria-controls={bodyId}
          onClick={() => setCollapsed(!isCollapsed)}
          data-testid={childTestId(testId, 'toggle')}
        >
          {isCollapsed ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
          {isCollapsed ? 'Show' : 'Hide'}
        </button>
      </div>
      {!isCollapsed && (
        <div className="canvas-key-legend" id={bodyId}>
          {shown.map((group) => (
            <section
              key={group.title}
              className="d-flex flex-column gap-1"
              data-testid={childTestId(testId, 'group')}
              data-test-key={group.title}
            >
              <h6 className="mb-1 canvas-key-legend-title">{group.title}</h6>
              {group.entries.map((entry) => (
                <div
                  key={`${entry.keys.join('+')} ${entry.label}`}
                  className={`d-flex align-items-center gap-3 canvas-key-legend-entry${
                    entry.active ? ' canvas-key-legend-entry--active' : ''
                  }`}
                >
                  <Keys keys={entry.keys} />
                  <span>{entry.label}</span>
                </div>
              ))}
              {group.note && <div className="canvas-key-legend-note">{group.note}</div>}
            </section>
          ))}
        </div>
      )}
    </div>
  );
};

export default CanvasKeyLegend;
