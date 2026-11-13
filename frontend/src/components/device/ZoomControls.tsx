import { Button, ButtonGroup } from 'react-bootstrap';
import { ArrowCounterclockwise, ZoomIn, ZoomOut } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { childTestId } from '../../testIds';
import './ZoomControls.css';

type ZoomControlsProps = {
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Back to the fitted view. */
  onReset: () => void;
  zoomOutDisabled?: boolean;
  resetDisabled: boolean;
  /** data-testid of the group; its buttons are "<testId>-in" / "-out" / "-reset". */
  testId?: string;
};

/** Zoom in/out/reset buttons in the top left corner of a plan view. */
const ZoomControls = ({
  onZoomIn,
  onZoomOut,
  onReset,
  zoomOutDisabled = false,
  resetDisabled,
  testId = 'zoom-controls',
}: ZoomControlsProps) => {
  const { t } = useTranslation();
  return (
    <ButtonGroup
      size="sm"
      vertical
      className="zoom-controls"
      data-testid={testId}
    >
      <Button
        variant="light"
        onClick={onZoomIn}
        title={t('heatmap_zoom_in')}
        aria-label={t('heatmap_zoom_in')}
        data-testid={childTestId(testId, 'in')}
      >
        <ZoomIn />
      </Button>
      <Button
        variant="light"
        onClick={onZoomOut}
        disabled={zoomOutDisabled}
        title={t('heatmap_zoom_out')}
        aria-label={t('heatmap_zoom_out')}
        data-testid={childTestId(testId, 'out')}
      >
        <ZoomOut />
      </Button>
      <Button
        variant="light"
        onClick={onReset}
        disabled={resetDisabled}
        title={`${t('heatmap_zoom_reset')} (${t('heatmap_canvas_hint')})`}
        aria-label={t('heatmap_zoom_reset')}
        data-testid={childTestId(testId, 'reset')}
      >
        <ArrowCounterclockwise />
      </Button>
    </ButtonGroup>
  );
};

export default ZoomControls;
