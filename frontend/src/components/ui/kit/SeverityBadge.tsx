import './kit.css';

export type Severity = 'beobachten' | 'alarm' | 'kritisch';

const SEVERITY_STYLE: Record<Severity, { color: string; background: string }> = {
  beobachten: { color: '#9A7208', background: '#FBF3DE' },
  alarm: { color: '#EB633B', background: '#FBEEE9' },
  kritisch: { color: '#C44D26', background: '#FBEAE4' },
};

type SeverityBadgeProps = {
  severity: Severity;
  label: string;
};

/** Colored severity pill (Beobachten / Alarm / Kritisch) - label passed in so callers keep i18n. */
const SeverityBadge = ({ severity, label }: SeverityBadgeProps) => (
  <span className="progeo-badge" style={SEVERITY_STYLE[severity]}>
    {label}
  </span>
);

export default SeverityBadge;
