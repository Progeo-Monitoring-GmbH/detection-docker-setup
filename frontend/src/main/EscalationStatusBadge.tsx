import { useTranslation } from 'react-i18next';
import { STATUS_STYLE, statusKey, type EscalationStatus } from './escalations';
import './Escalation.css';

/** Coloured status pill of an escalation (like StateBadge for alarms). */
const EscalationStatusBadge = ({
  status,
  testId = 'escalation-status-badge',
  testKey,
}: {
  status: EscalationStatus;
  /** data-testid of the badge (src/testIds.ts). */
  testId?: string;
  /** Tells copies of a repeated badge apart (data-test-key). */
  testKey?: string | number;
}) => {
  const { t } = useTranslation();
  const style = STATUS_STYLE[status];
  return (
    <span
      className="escalation-status-badge"
      data-testid={testId}
      data-test-key={testKey}
      style={{ color: style.color, background: style.bg }}
    >
      {t(statusKey(status))}
    </span>
  );
};

export default EscalationStatusBadge;
