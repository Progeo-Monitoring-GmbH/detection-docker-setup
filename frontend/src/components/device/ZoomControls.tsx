import { Button, ButtonGroup } from 'react-bootstrap';
import { ArrowCounterclockwise, ZoomIn, ZoomOut } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';

type ZoomControlsProps = {
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Back to the fitted view. */
  onReset: () => void;
  zoomOutDisabled?: boolean;
  resetDisabled: boolean;
};

/** Zoom in/out/reset buttons in the top left corner of a plan view. */
const ZoomControls = ({
  onZoomIn,
  onZoomOut,
  onReset,
  zoomOutDisabled = false,
  resetDisabled,
}: ZoomControlsProps) => {
  const { t } = useTranslation();
  return (
    <ButtonGroup
      size="sm"
      vertical
      style={{ position: 'absolute', left: 8, top: 8, boxShadow: '0 2px 8px rgba(11, 54, 89, .18)' }}
    >
      <Button variant="light" onClick={onZoomIn} title={t('heatmap_zoom_in')} aria-label={t('heatmap_zoom_in')}>
        <ZoomIn />
      </Button>
      <Button
        variant="light"
        onClick={onZoomOut}
        disabled={zoomOutDisabled}
        title={t('heatmap_zoom_out')}
        aria-label={t('heatmap_zoom_out')}
      >
        <ZoomOut />
      </Button>
      <Button
        variant="light"
        onClick={onReset}
        disabled={resetDisabled}
        title={`${t('heatmap_zoom_reset')} (${t('heatmap_canvas_hint')})`}
        aria-label={t('heatmap_zoom_reset')}
      >
        <ArrowCounterclockwise />
      </Button>
    </ButtonGroup>
  );
};

export default ZoomControls;
