import './kit.css';

export type AlarmState = 'neu' | 'quittiert' | 'geloest';

const STATE_STYLE: Record<AlarmState, { color: string; background: string }> = {
  neu: { color: '#9A7208', background: '#FBF3DE' },
  quittiert: { color: '#6E6868', background: '#EFECEC' },
  geloest: { color: '#3F7A1C', background: '#EBF4E3' },
};

type StateBadgeProps = {
  state: AlarmState;
  label: string;
};

/** Colored state pill (NEU / QUITTIERT / GELÖST) - label passed in so callers keep i18n. */
const StateBadge = ({ state, label }: StateBadgeProps) => (
  <span className="progeo-badge progeo-badge--wide" style={STATE_STYLE[state]}>
    {label}
  </span>
);

export default StateBadge;
