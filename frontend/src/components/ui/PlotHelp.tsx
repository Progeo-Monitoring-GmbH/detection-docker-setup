import type { CSSProperties } from 'react';
import { OverlayTrigger, Popover } from 'react-bootstrap';
import { QuestionLg } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';

/** The plots with a help text: i18n plot_help_<topic>_title / _what / _how. */
type PlotHelpTopic =
  | 'heatmap'
  | 'by_sensor'
  | 'sensors_over_time'
  | 'sensor_sum'
  | 'compare'
  | 'status_plan'
  | 'status_zeitreihe';

type PlotHelpProps = {
  topic: PlotHelpTopic;
  /** Where the button sits (e.g. absolutely over a plot). */
  style?: CSSProperties;
  className?: string;
};

/**
 * A small "?" next to a plot: a click shows, in a popover, what the plot
 * displays and how it is used - a click elsewhere closes it.
 */
const PlotHelp = ({ topic, style, className }: PlotHelpProps) => {
  const { t } = useTranslation();
  const title = t(`plot_help_${topic}_title`);
  const popover = (
    <Popover id={`plot-help-${topic}`} style={{ maxWidth: 380 }}>
      <Popover.Header as="div" className="fw-semibold" style={{ fontSize: 13.5 }}>
        {title}
      </Popover.Header>
      <Popover.Body style={{ fontSize: 12.5, lineHeight: 1.45 }}>
        <div className="fw-semibold mb-1">{t('plot_help_what')}</div>
        <p className="mb-2">{t(`plot_help_${topic}_what`)}</p>
        <div className="fw-semibold mb-1">{t('plot_help_how')}</div>
        <p className="mb-0">{t(`plot_help_${topic}_how`)}</p>
      </Popover.Body>
    </Popover>
  );
  return (
    <OverlayTrigger trigger="click" placement="auto" rootClose overlay={popover}>
      <button
        type="button"
        className={`btn btn-light d-inline-flex align-items-center justify-content-center p-0 ${className ?? ''}`}
        aria-label={t('plot_help_open', { title })}
        title={t('plot_help_open', { title })}
        data-testid={`plot-help-${topic}`}
        style={{
          width: 24,
          height: 24,
          borderRadius: '50%',
          border: '1px solid var(--progeo-warm-gray-3, #d6d0d0)',
          color: 'var(--progeo-blue)',
          flexShrink: 0,
          ...style,
        }}
      >
        <QuestionLg size={13} />
      </button>
    </OverlayTrigger>
  );
};

export default PlotHelp;
