import type { CSSProperties } from 'react';
import { OverlayTrigger, Popover } from 'react-bootstrap';
import { QuestionLg } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';

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

const SECTION_TITLE: CSSProperties = {
  fontSize: 11,
  letterSpacing: '.05em',
  textTransform: 'uppercase',
  color: '#8B8383',
  fontWeight: 600,
  marginBottom: 4,
};

/**
 * A small "?" next to a plot: a click shows, in a popover, what the plot
 * displays, its actions ("action::effect", one per line) and typical
 * workflows ("goal::step → step", one per line) - a click elsewhere closes it.
 */
const PlotHelp = ({ topic, style, className }: PlotHelpProps) => {
  const { t } = useTranslation();
  const title = t(`plot_help_${topic}_title`);
  const actions = helpLines(t(`plot_help_${topic}_actions`));
  const workflows = helpLines(t(`plot_help_${topic}_workflows`));
  const popover = (
    <Popover id={`plot-help-${topic}`} style={{ maxWidth: 420 }}>
      <Popover.Header as="div" className="fw-semibold" style={{ fontSize: 13.5 }}>
        {title}
      </Popover.Header>
      <Popover.Body style={{ fontSize: 12.5, lineHeight: 1.45 }}>
        <p className="mb-2">{t(`plot_help_${topic}_what`)}</p>
        <div style={SECTION_TITLE}>{t('plot_help_actions')}</div>
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
            <div style={SECTION_TITLE}>{t('plot_help_workflows')}</div>
            {workflows.map((entry) => (
              <div
                key={`${entry.lead}${entry.rest}`}
                className="mb-1 px-2 py-1"
                style={{ background: 'var(--progeo-panel-bg, #f3f1f0)', borderRadius: 6 }}
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
