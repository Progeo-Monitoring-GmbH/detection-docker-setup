/**
 * The legend under a plan canvas (ImageCanvasStage): what the mouse and the
 * keys do, in groups - the action in use (a held key, an edit mode) is
 * highlighted.
 */

/** A keyboard key in a hint. */
export const KEY_BADGE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 24,
  height: 24,
  padding: '0 6px',
  borderRadius: 6,
  background: '#ffffff',
  color: 'var(--progeo-blue)',
  border: '1px solid #cfd4da',
  boxShadow: 'inset 0 -2px 0 #cfd4da',
  fontSize: 12,
  fontWeight: 700,
};

/** A mouse action (drag, click, ...) - told apart from the keys. */
const MOUSE_BADGE: React.CSSProperties = {
  ...KEY_BADGE,
  borderRadius: 'var(--progeo-radius-pill)',
  background: 'transparent',
  color: '#495057',
  border: '1px dashed #adb5bd',
  boxShadow: 'none',
  padding: '0 9px',
  fontWeight: 600,
};
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

const CanvasKeyLegend = ({ groups }: { groups: Array<LegendGroup | false | null | undefined> }) => {
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
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: '14px 28px',
        background: 'var(--progeo-surface)',
        borderRadius: 13,
        padding: '14px 16px',
      }}
    >
      {shown.map((group) => (
        <section key={group.title} className="d-flex flex-column gap-1">
          <h6
            className="mb-1"
            style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: '#8B8383' }}
          >
            {group.title}
          </h6>
          {group.entries.map((entry) => (
            <div
              key={`${entry.keys.join('+')} ${entry.label}`}
              className="d-flex align-items-center gap-3"
              style={{
                fontSize: 13.5,
                lineHeight: 1.35,
                padding: '4px 8px',
                margin: '0 -8px',
                borderRadius: 8,
                color: entry.active ? '#0B3659' : '#343a40',
                background: entry.active ? '#E7F0FD' : 'transparent',
                fontWeight: entry.active ? 600 : 400,
                transition: 'background-color .15s',
              }}
            >
              <span className="d-inline-flex align-items-center gap-1 flex-shrink-0" style={{ minWidth: 104 }}>
                {entry.keys.map((key, index) => (
                  <span key={key} className="d-inline-flex align-items-center gap-1">
                    {index > 0 && <span style={{ color: '#adb5bd', fontSize: 12 }}>+</span>}
                    <kbd style={MOUSE_ACTIONS.has(key) ? MOUSE_BADGE : KEY_BADGE}>{key}</kbd>
                  </span>
                ))}
              </span>
              <span>{entry.label}</span>
            </div>
          ))}
          {group.note && <div style={{ fontSize: 12, color: '#8B8383', marginTop: 2 }}>{group.note}</div>}
        </section>
      ))}
    </div>
  );
};

export default CanvasKeyLegend;
