import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { childTestId } from '../testIds';
import type { mixerCountsOf } from './thresholdMixerView';

const LegendItem = ({ swatch, label }: { swatch: ReactNode; label: string }) => (
  <span className="threshold-mixer-legend-item">
    {swatch}
    {label}
  </span>
);

/** What the plot's colours mean, with the counts; editors also get the usage line. */
const ThresholdMixerLegend = ({
  testId,
  canEdit,
  counts,
}: {
  testId: string;
  canEdit: boolean;
  counts: ReturnType<typeof mixerCountsOf>;
}) => {
  const { t } = useTranslation();
  return (
    <div className="d-flex align-items-center gap-3 flex-wrap threshold-mixer-legend" data-testid={childTestId(testId, 'legend')}>
      <LegendItem swatch={<span className="threshold-mixer-swatch" />} label={t('einstell_mixer_max_legend')} />
      <LegendItem
        swatch={<span className="threshold-mixer-swatch threshold-mixer-swatch--over" />}
        label={t('einstell_mixer_over_legend', { count: counts.over })}
      />
      <LegendItem
        swatch={<span className="threshold-mixer-swatch threshold-mixer-swatch--protected" />}
        label={t('einstell_mixer_protected_legend')}
      />
      <LegendItem swatch={<span className="threshold-mixer-swatch-object" />} label={t('einstell_mixer_object')} />
      <LegendItem
        swatch={<span className="threshold-mixer-swatch-own" />}
        label={t('einstell_mixer_own_legend', { count: counts.own })}
      />
      <LegendItem
        swatch={<span className="threshold-mixer-swatch threshold-mixer-swatch--disabled" />}
        label={t('einstell_mixer_disabled_legend', { count: counts.disabled })}
      />
      <span className="threshold-mixer-usage">{canEdit ? t('einstell_mixer_usage') : null}</span>
    </div>
  );
};

export default ThresholdMixerLegend;
