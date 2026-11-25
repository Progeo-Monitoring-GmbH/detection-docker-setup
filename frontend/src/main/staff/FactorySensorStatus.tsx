import { useTranslation } from 'react-i18next';
import type { SensorStatus } from './factorySensors';
import './FactorySensorsView.css';

type Props = {
  status: SensorStatus;
  /** data-testid / data-test-key - a badge per row. */
  testId?: string;
  testKey?: string | number;
};

/** The status pill of a sensor / measurement (OK, Prüfen, Defekt, Unklar, ungemessen). */
export const StatusBadge = ({ status, testId, testKey }: Props) => {
  const { t } = useTranslation();
  return (
    <span
      className={`progeo-badge fs-status fs-status--${status}`}
      data-testid={testId}
      data-test-key={testKey == null ? undefined : String(testKey)}
    >
      {t(`fs_status_${status}`)}
    </span>
  );
};
