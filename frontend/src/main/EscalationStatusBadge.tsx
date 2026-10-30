import { useTranslation } from 'react-i18next';
import { STATUS_STYLE, statusKey, type EscalationStatus } from './escalations';

/** Coloured status pill of an escalation (like StateBadge for alarms). */
const EscalationStatusBadge = ({ status }: { status: EscalationStatus }) => {
  const { t } = useTranslation();
  const style = STATUS_STYLE[status];
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
      {t(statusKey(status))}
    </span>
  );
};

export default EscalationStatusBadge;
