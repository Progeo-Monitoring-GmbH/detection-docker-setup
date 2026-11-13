import type { ReactNode } from 'react';
import { Button, Form, Spinner } from 'react-bootstrap';
import { Film } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import type { SensorHeatmapLageplanData } from './sensorHeatmapTypes';
import type { VideoExportStage } from './useHeatmapFrameExport';
import { childTestId, repeatedTestId } from '../../testIds';
import './HeatmapToolbar.css';

type HeatmapToolbarProps = {
  /** First in the row - e.g. the page's own plan switcher. */
  start?: ReactNode;
  /** After the plan switcher - e.g. the heat limitations. */
  middle?: ReactNode;
  /** Lageplans to switch between; null hides the switcher. */
  plans: SensorHeatmapLageplanData[] | null;
  planIndex: number;
  onPlanChange: (index: number) => void;
  /** The kernel width (σ) and its change - staff only; without it no σ controls. */
  sigma?: { value: 'auto' | number; onChange: (sigma: 'auto' | number) => void };
  video: {
    exporting: boolean;
    stage: VideoExportStage | null;
    /** Progress of the capturing stage (0..1). */
    progress: number;
    resultUrl: string | null;
    download: () => Promise<void>;
    start: () => Promise<void>;
    /** Whether there are frames to export. */
    enabled: boolean;
  };
  /** data-testid of the toolbar; its controls are "<testId>-plan", "-auto-sigma", "-sigma", "-video-export", ... */
  testId?: string;
};

const STAGE_KEYS: Record<Exclude<VideoExportStage, 'capturing'>, string> = {
  uploading: 'heatmap_video_stage_uploading',
  rendering: 'heatmap_video_stage_rendering',
  downloading: 'heatmap_video_stage_downloading',
};

/**
 * One compact toolbar row of SensorHeatmap2D (wraps on narrow cards): the
 * page's own controls (`start`), the Lageplan switcher, the heat limitations
 * (`middle`) and - on the right - the kernel width (σ, staff only; stored per
 * plan) and the video export; the kernel width sits with the export, both
 * shape the video.
 */
const HeatmapToolbar = ({
  start,
  middle,
  plans,
  planIndex,
  onPlanChange,
  sigma,
  video,
  testId = 'heatmap-toolbar',
}: HeatmapToolbarProps) => {
  const { t } = useTranslation();
  const stageText =
    video.stage === 'capturing'
      ? t('heatmap_video_stage_capturing', { percent: Math.round(video.progress * 100) })
      : t(STAGE_KEYS[video.stage ?? 'downloading']);

  return (
    <div className="d-flex flex-wrap align-items-center gap-2" data-testid={testId}>
      {start}
      {plans && plans.length > 1 && (
        <Form.Select
          size="sm"
          aria-label="Select lageplan"
          title={`Lageplan ${planIndex + 1} / ${plans.length}`}
          value={planIndex}
          onChange={(event) => onPlanChange(Number(event.target.value))}
          className="heatmap-toolbar-plan"
          data-testid={childTestId(testId, 'plan')}
        >
          {plans.map((plan, index) => (
            <option
              key={plan.id ?? index}
              value={index}
              {...repeatedTestId(`${testId}-plan-option`, plan.id ?? index)}
            >
              {plan.name || `Lageplan ${index + 1}`}
              {plan.is_active ? ' (aktiv)' : ''}
            </option>
          ))}
        </Form.Select>
      )}
      {middle}

      <div className="ms-auto d-flex flex-wrap align-items-center justify-content-end gap-2">
        {sigma && (
          <Form.Check
            type="switch"
            id="heatmap2d-auto-sigma"
            className="small mb-0"
            label={'Auto σ'}
            checked={sigma.value === 'auto'}
            onChange={(event) => sigma.onChange(event.target.checked ? 'auto' : 0.04)}
            disabled={video.exporting}
            data-testid={childTestId(testId, 'auto-sigma')}
          />
        )}
        {sigma && sigma.value !== 'auto' && (
          <div className="heatmap-toolbar-sigma d-flex align-items-center gap-2">
            <label
              htmlFor="heatmap2d-sigma"
              className="small text-muted mb-0 text-nowrap"
              title="σ (kernel width)"
              data-testid={childTestId(testId, 'sigma-value')}
            >
              {'σ'} {sigma.value.toFixed(3)}
            </label>
            <input
              id="heatmap2d-sigma"
              type="range"
              className="form-range"
              min={0.005}
              max={0.15}
              step={0.005}
              value={sigma.value}
              onChange={(event) => sigma.onChange(Number(event.target.value))}
              disabled={video.exporting}
              data-testid={childTestId(testId, 'sigma')}
            />
          </div>
        )}
        {video.exporting ? (
          <>
            <Spinner size="sm" animation="border" />
            <span className="text-muted small" data-testid={childTestId(testId, 'video-stage')}>
              {stageText}
            </span>
          </>
        ) : (
          <>
            {video.resultUrl && (
              <span className="small" data-testid={childTestId(testId, 'video-ready')}>
                {t('heatmap_video_ready')} -{' '}
                <Button
                  variant="link"
                  size="sm"
                  className="p-0 align-baseline"
                  onClick={() => void video.download()}
                  data-testid={childTestId(testId, 'video-download')}
                >
                  {t('heatmap_video_download')}
                </Button>
              </span>
            )}
            <Button
              size="sm"
              variant="outline-danger"
              onClick={() => void video.start()}
              disabled={!video.enabled}
              aria-label={t('heatmap_video_export')}
              title={t('heatmap_video_export_title')}
              data-testid={childTestId(testId, 'video-export')}
            >
              <Film />
            </Button>
          </>
        )}
      </div>
    </div>
  );
};

export default HeatmapToolbar;
