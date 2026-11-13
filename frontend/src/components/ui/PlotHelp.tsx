import type { CSSProperties } from 'react';
import { OverlayTrigger, Popover } from 'react-bootstrap';
import { QuestionLg } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { childTestId } from '../../testIds';
import './PlotHelp.css';

/** The plots with a help text: i18n plot_help_<topic>_title / _what /
 * _actions / _workflows. */
type PlotHelpTopic =
  | 'heatmap'
  | 'by_sensor'
  | 'sensors_over_time'
  | 'sensor_sum'
  | 'compare'
  | 'status_plan'
  | 'status_zeitreihe'
  | 'climate_heatmap'
  | 'climate_chart'
  | 'noise_profile';

type PlotHelpProps = {
  topic: PlotHelpTopic;
  /** Where the button sits (e.g. absolutely over a plot). */
  style?: CSSProperties;
  className?: string;
  /** data-testid of the button (default "plot-help-<topic>"); its popover is "<testId>-popover". */
  testId?: string;
};

/** Splits "lead::rest" - the lead in bold; a line without "::" is all rest. */
const helpEntry = (line: string) => {
  const at = line.indexOf('::');
  return at < 0 ? { lead: '', rest: line } : { lead: line.slice(0, at).trim(), rest: line.slice(at + 2).trim() };
};

/** One short statement per line - empty lines dropped. */
export const helpLines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(helpEntry);

/**
 * A small "?" next to a plot: a click shows, in a popover, what the plot
 * displays, its actions ("action::effect", one per line) and typical
 * workflows ("goal::step → step", one per line) - a click elsewhere closes it.
 */
const PlotHelp = ({ topic, style, className, testId = `plot-help-${topic}` }: PlotHelpProps) => {
  const { t } = useTranslation();
  const title = t(`plot_help_${topic}_title`);
  const actions = helpLines(t(`plot_help_${topic}_actions`));
  const workflows = helpLines(t(`plot_help_${topic}_workflows`));
  const popover = (
    <Popover id={`plot-help-${topic}`} className="plot-help-popover" data-testid={childTestId(testId, 'popover')}>
      <Popover.Header as="div" className="fw-semibold plot-help-title">
        {title}
      </Popover.Header>
      <Popover.Body className="plot-help-body">
        <p className="mb-2">{t(`plot_help_${topic}_what`)}</p>
        <div className="plot-help-section-title">{t('plot_help_actions')}</div>
        <ul className="mb-2 ps-3">
          {actions.map((entry) => (
            <li key={`${entry.lead}${entry.rest}`}>
              {entry.lead && <span className="fw-semibold">{entry.lead}</span>}
              {entry.lead && ' → '}
              {entry.rest}
            </li>
          ))}
        </ul>
        {workflows.length > 0 && (
          <>
            <div className="plot-help-section-title">{t('plot_help_workflows')}</div>
            {workflows.map((entry) => (
              <div
                key={`${entry.lead}${entry.rest}`}
                className="mb-1 px-2 py-1 plot-help-workflow"
              >
                {entry.lead && <div className="fw-semibold">{entry.lead}</div>}
                <div>{entry.rest}</div>
              </div>
            ))}
          </>
        )}
      </Popover.Body>
    </Popover>
  );
  return (
    <OverlayTrigger trigger="click" placement="auto" rootClose overlay={popover}>
      <button
        type="button"
        className={`btn btn-light d-inline-flex align-items-center justify-content-center p-0 plot-help-button ${className ?? ''}`}
        aria-label={t('plot_help_open', { title })}
        title={t('plot_help_open', { title })}
        data-testid={testId}
        style={style}
      >
        <QuestionLg size={13} />
      </button>
    </OverlayTrigger>
  );
};

export default PlotHelp;
