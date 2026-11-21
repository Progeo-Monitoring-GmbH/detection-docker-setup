import { useTranslation } from 'react-i18next';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import { childTestId } from '../testIds';
import { PERIODS } from './thresholdMixerView';

/**
 * The panel head's actions: where the maxima come from - the page's data
 * (`note`, no period of its own to pick) or the picked period.
 */
export const ThresholdMixerSource = ({
  testId,
  note,
  days,
  onPeriod,
}: {
  testId: string;
  /** Set with the page's loaded data. */
  note: string | null;
  days: number;
  onPeriod: (days: number) => void;
}) => {
  const { t } = useTranslation();
  if (note != null) {
    return (
      <span className="threshold-mixer-muted" data-testid={childTestId(testId, 'source')}>
        {note}
      </span>
    );
  }
  // Labelled: on its own the chips read as a filter of unknown meaning
  // (on phones they wrap below the title, away from any context).
  return (
    <div className="threshold-mixer-period">
      <span className="threshold-mixer-period-label">{t('einstell_mixer_period')}</span>
      <SegmentedControl
        options={PERIODS.map((period) => ({
          value: String(period),
          label: period === 1 ? t('einstell_mixer_24h') : t('einstell_mixer_days', { count: period }),
        }))}
        value={String(days)}
        onChange={(value) => onPeriod(Number(value))}
        testId={childTestId(testId, 'period')}
      />
    </div>
  );
};

/** The object's alarm threshold: intro text and the typed value. */
const ThresholdMixerObjectRow = ({
  testId,
  canEdit,
  objectThreshold,
  step,
  onChange,
}: {
  testId: string;
  canEdit: boolean;
  objectThreshold: number | null;
  step: number;
  onChange: (value: number | null) => void;
}) => {
  const { t } = useTranslation();
  return (
    <div className="d-flex align-items-center gap-3 flex-wrap">
      <div className="threshold-mixer-intro">
        <div className="threshold-mixer-intro-title">{t('einstell_alarm_threshold')}</div>
        <div className="threshold-mixer-muted">{t('einstell_mixer_hint')}</div>
      </div>
      <label className="d-flex align-items-center gap-2 mb-0">
        <input
          type="number"
          min={0}
          step={step}
          aria-label={t('einstell_alarm_threshold')}
          value={objectThreshold ?? ''}
          readOnly={!canEdit}
          onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
          className="threshold-mixer-object-input"
          data-testid={childTestId(testId, 'object-input')}
        />
        <span className="threshold-mixer-unit">mV</span>
      </label>
    </div>
  );
};

export default ThresholdMixerObjectRow;
