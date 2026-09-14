export type Severity = 'beobachten' | 'alarm' | 'kritisch';

const SEVERITY_STYLE: Record<Severity, { color: string; bg: string }> = {
  beobachten: { color: '#9A7208', bg: '#FBF3DE' },
  alarm: { color: '#EB633B', bg: '#FBEEE9' },
  kritisch: { color: '#C44D26', bg: '#FBEAE4' },
};

type SeverityBadgeProps = {
  severity: Severity;
  label: string;
};

/** Colored severity pill (Beobachten / Alarm / Kritisch) - label passed in so callers keep i18n. */
const SeverityBadge = ({ severity, label }: SeverityBadgeProps) => {
  const style = SEVERITY_STYLE[severity];
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '.03em',
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

export default SeverityBadge;
