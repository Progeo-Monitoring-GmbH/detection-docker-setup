import { useTranslation } from 'react-i18next';
import PillSelect from '../components/ui/kit/PillSelect';
import { timeRangeShortLabelKey, type StatusRange } from './timeRanges';

type TimeRangeSelectProps<R extends StatusRange> = {
  ranges: readonly R[];
  value: R;
  onChange: (range: R) => void;
  /** data-testid of the select; the ranges are its option values. */
  testId?: string;
};

/**
 * The period picker of the location views (status page, Analyse, climate
 * charts): a "Zeitraum" label and one compact pill showing the chosen range
 * ("7 Tage") - a dropdown with the ranges, no row of buttons that wraps.
 */
const TimeRangeSelect = <R extends StatusRange>({
  ranges,
  value,
  onChange,
  testId,
}: TimeRangeSelectProps<R>) => {
  const { t } = useTranslation();
  return (
    <PillSelect
      testId={testId}
      label={t('time_range_label')}
      options={ranges.map((range) => ({ value: range, label: t(timeRangeShortLabelKey(range)) }))}
      value={value}
      onChange={(next) => onChange(next as R)}
    />
  );
};

export default TimeRangeSelect;
