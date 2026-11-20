import { type ReactNode } from 'react';
import { Button, Spinner } from 'react-bootstrap';
import { XLg } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import FrameSlider from '../components/device/FrameSlider';
import type { KeyHint } from '../components/ui/KeyHints';
import UsageHelp from '../components/ui/UsageHelp';
import PillSelect from '../components/ui/kit/PillSelect';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import { MEAN_WINDOWS } from './analyseSmoothing';
import type { CompareOffset } from './analyseCompare';
import type { ProfileRange } from './NoiseProfilePanel';
import { timeRangeLabelKey, type TimeRange } from './timeRanges';

const RESOLUTIONS = [300, 600, 1000, 2000] as const;
const STICKY_TOP = 0;
const STICKY_TOP_MOBILE = 60;

type AnalyseFrameControlProps = {
  mobile: boolean;
  isLorawan: boolean;
  rangeOptions: TimeRange[];
  range: TimeRange;
  onRangeChange: (range: TimeRange) => void;
  resolution: number;
  onResolutionChange: (resolution: number) => void;
  meanWindow: number;
  onMeanWindowChange: (window: number) => void;
  compareOptions: readonly CompareOffset[];
  compare: CompareOffset | null;
  onCompareChange: (days: number | null) => void;
  loading: boolean;
  hasLoadedData: boolean;
  noiseBadge: ReactNode;
  frameSeconds: number[];
  frameIndex: number;
  onTimeChange: (time: number | null) => void;
  chartZoom: { from: number; to: number } | null;
  selection: ProfileRange | null;
  onSelectionChange?: (selection: ProfileRange | null) => void;
  keyHints: KeyHint[];
  tips: string[];
};

const AnalyseFrameControl = ({
  mobile,
  isLorawan,
  rangeOptions,
  range,
  onRangeChange,
  resolution,
  onResolutionChange,
  meanWindow,
  onMeanWindowChange,
  compareOptions,
  compare,
  onCompareChange,
  loading,
  hasLoadedData,
  noiseBadge,
  frameSeconds,
  frameIndex,
  onTimeChange,
  chartZoom,
  selection,
  onSelectionChange,
  keyHints,
  tips,
}: AnalyseFrameControlProps) => {
  const { t } = useTranslation();
  const rangeToolbar = (
    <div className="d-flex flex-wrap align-items-center gap-2">
      <SegmentedControl
        testId="analyse-range"
        options={rangeOptions.map((value) => ({
          value,
          label: t(timeRangeLabelKey(value)),
        }))}
        value={range}
        onChange={(value) => onRangeChange(value as TimeRange)}
      />
      {!isLorawan && (
        <>
          <PillSelect
            testId="analyse-resolution"
            label={t('analyse_resolution')}
            title={t('analyse_resolution_hint')}
            options={RESOLUTIONS.map((value) => ({
              value: String(value),
              label: t('analyse_resolution_option', { count: value }),
            }))}
            value={String(resolution)}
            onChange={(value) => onResolutionChange(Number(value))}
          />
          <PillSelect
            testId="analyse-mean"
            label={t('analyse_mean')}
            title={t('analyse_mean_hint')}
            options={MEAN_WINDOWS.map((value) => ({
              value: String(value),
              label:
                value === 1
                  ? t('analyse_mean_off')
                  : t('analyse_mean_option', { count: value }),
            }))}
            value={String(meanWindow)}
            onChange={(value) => onMeanWindowChange(Number(value))}
          />
          <PillSelect
            testId="analyse-compare-select"
            label={t('analyse_compare')}
            title={
              compareOptions.length
                ? t('analyse_compare_hint')
                : t('analyse_compare_unavailable')
            }
            options={[
              { value: '', label: t('analyse_compare_none') },
              ...compareOptions.map((offset) => ({
                value: String(offset.days),
                label: t(`analyse_compare_${offset.key}`),
              })),
            ]}
            value={compare ? String(compare.days) : ''}
            onChange={(value) => onCompareChange(value ? Number(value) : null)}
          />
          {compare && (
            <Button
              size="sm"
              variant="outline-secondary"
              className="d-inline-flex align-items-center gap-1 py-0 analyse-compare-end"
              onClick={() => onCompareChange(null)}
              data-testid="analyse-compare-end"
            >
              <XLg size={11} />
              {t('analyse_compare_end')}
            </Button>
          )}
        </>
      )}
      {!isLorawan && loading && hasLoadedData && (
        <Spinner
          size="sm"
          animation="border"
          className="text-muted"
          data-testid="analyse-range-loading"
        />
      )}
      {noiseBadge}
      {frameSeconds.length > 0 && (
        <span className="ms-auto">
          <UsageHelp
            id="analyse-usage-help"
            hints={keyHints}
            tips={tips}
            testId="analyse-usage-help"
          />
        </span>
      )}
    </div>
  );
  return (
    <div
      data-testid="analyse-frame-slider"
      className="px-3 analyse-frame-slider"
      style={{ top: mobile ? STICKY_TOP_MOBILE : STICKY_TOP }}
    >
      {frameSeconds.length > 0 ? (
        <FrameSlider
          id="analyse-frame"
          timestamps={frameSeconds}
          index={frameIndex}
          onChange={(index) => onTimeChange(frameSeconds[index] * 1000)}
          visibleRange={isLorawan ? null : chartZoom}
          toolbar={rangeToolbar}
          selection={selection}
          onSelectionChange={
            selection != null || onSelectionChange
              ? (value) => onSelectionChange?.(value)
              : undefined
          }
          selectionLabel={t('noise_profile_range_band')}
        />
      ) : (
        <div
          className="d-flex flex-wrap align-items-center gap-2 py-3"
          data-testid="analyse-range-toolbar"
        >
          {rangeToolbar}
        </div>
      )}
    </div>
  );
};

export default AnalyseFrameControl;
