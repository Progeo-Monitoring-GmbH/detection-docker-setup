import { Button, Form, Spinner } from 'react-bootstrap';
import { Film } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import type { SensorHeatmapLageplanData } from './sensorHeatmapTypes';
import type { VideoExportStage } from './useHeatmapFrameExport';

type HeatmapToolbarProps = {
  /** Lageplans to switch between; null hides the switcher. */
  plans: SensorHeatmapLageplanData[] | null;
  planIndex: number;
  onPlanChange: (index: number) => void;
  sigma: 'auto' | number;
  onSigmaChange: (sigma: 'auto' | number) => void;
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
};

const STAGE_KEYS: Record<Exclude<VideoExportStage, 'capturing'>, string> = {
  uploading: 'heatmap_video_stage_uploading',
  rendering: 'heatmap_video_stage_rendering',
  downloading: 'heatmap_video_stage_downloading',
};

/**
 * One compact toolbar row of SensorHeatmap2D (wraps on narrow cards): the
 * Lageplan switcher, the kernel width (σ) and the video export - the kernel
 * width sits with the export, both shape the video.
 */
const HeatmapToolbar = ({
  plans,
  planIndex,
  onPlanChange,
  sigma,
  onSigmaChange,
  video,
}: HeatmapToolbarProps) => {
  const { t } = useTranslation();
  const stageText =
    video.stage === 'capturing'
      ? t('heatmap_video_stage_capturing', { percent: Math.round(video.progress * 100) })
      : t(STAGE_KEYS[video.stage ?? 'downloading']);

  return (
    <div className="d-flex flex-wrap align-items-center gap-2">
      {plans && plans.length > 1 && (
        <Form.Select
          size="sm"
          aria-label="Select lageplan"
          title={`Lageplan ${planIndex + 1} / ${plans.length}`}
          value={planIndex}
          onChange={(event) => onPlanChange(Number(event.target.value))}
          style={{ width: 'auto', maxWidth: 200 }}
        >
          {plans.map((plan, index) => (
            <option key={plan.id ?? index} value={index}>
              {plan.name || `Lageplan ${index + 1}`}
              {plan.is_active ? ' (aktiv)' : ''}
            </option>
          ))}
        </Form.Select>
      )}

      <div className="ms-auto d-flex flex-wrap align-items-center justify-content-end gap-2">
        <Form.Check
          type="switch"
          id="heatmap2d-auto-sigma"
          className="small mb-0"
          label={'Auto σ'}
          checked={sigma === 'auto'}
          onChange={(event) => onSigmaChange(event.target.checked ? 'auto' : 0.04)}
          disabled={video.exporting}
        />
        {sigma !== 'auto' && (
          <div className="d-flex align-items-center gap-2" style={{ width: 190 }}>
            <label
              htmlFor="heatmap2d-sigma"
              className="small text-muted mb-0 text-nowrap"
              title="σ (kernel width)"
            >
              {'σ'} {sigma.toFixed(3)}
            </label>
            <input
              id="heatmap2d-sigma"
              type="range"
              className="form-range"
              min={0.005}
              max={0.15}
              step={0.005}
              value={sigma}
              onChange={(event) => onSigmaChange(Number(event.target.value))}
              disabled={video.exporting}
            />
          </div>
        )}
        {video.exporting ? (
          <>
            <Spinner size="sm" animation="border" />
            <span className="text-muted small">{stageText}</span>
          </>
        ) : (
          <>
            {video.resultUrl && (
              <span className="small">
                {t('heatmap_video_ready')} -{' '}
                <Button
                  variant="link"
                  size="sm"
                  className="p-0 align-baseline"
                  onClick={() => void video.download()}
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
