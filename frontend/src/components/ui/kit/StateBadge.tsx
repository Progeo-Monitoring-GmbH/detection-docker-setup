export type AlarmState = 'neu' | 'quittiert' | 'geloest';

const STATE_STYLE: Record<AlarmState, { color: string; bg: string }> = {
  neu: { color: '#9A7208', bg: '#FBF3DE' },
  quittiert: { color: '#6E6868', bg: '#EFECEC' },
  geloest: { color: '#3F7A1C', bg: '#EBF4E3' },
};

type StateBadgeProps = {
  state: AlarmState;
  label: string;
};

/** Colored state pill (NEU / QUITTIERT / GELÖST) - label passed in so callers keep i18n. */
const StateBadge = ({ state, label }: StateBadgeProps) => {
  const style = STATE_STYLE[state];
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '.05em',
        textTransform: 'uppercase',
        color: style.color,
        background: style.bg,
        borderRadius: 'var(--progeo-radius-pill)',
        padding: '3px 10px',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
};

export default StateBadge;
