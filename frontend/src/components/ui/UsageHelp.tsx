import { OverlayTrigger, Popover } from 'react-bootstrap';
import { Keyboard, Lightbulb } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import KeyHints, { type KeyHint, useFlashedKey } from './KeyHints';

type UsageHelpProps = {
  /** Popover id - unique per page. */
  id: string;
  /** The keys and mouse actions. */
  hints: KeyHint[];
  /** What is useful right now - from the page's state, the first ones count most. */
  tips?: string[];
  /** Off: the keys don't work yet (e.g. the plot has no focus) - said in the popover. */
  active?: boolean;
  inactiveNote?: string;
  placement?: 'bottom-end' | 'bottom-start' | 'top-end' | 'top-start';
};

const SECTION_TITLE = {
  fontSize: 11,
  letterSpacing: '.05em',
  textTransform: 'uppercase' as const,
  color: '#8B8383',
  fontWeight: 600,
  marginBottom: 4,
};

/**
 * The usage help of a page or plot: a small "Bedienung" button - hovering or
 * focusing it shows what is useful right now (`tips`) and every key and
 * mouse action (`hints`). Nothing stays on screen permanently; only when a
 * handler processed a key (announceKey) its effect shows next to the button
 * for a moment ("← / → · ein Bild"), so a press never goes by unnoticed.
 */
const UsageHelp = ({ id, hints, tips = [], active = true, inactiveNote, placement = 'bottom-end' }: UsageHelpProps) => {
  const { t } = useTranslation();
  const flashed = useFlashedKey(1400);
  const processed = active ? hints.find((hint) => hint.id != null && hint.id === flashed) : undefined;

  const popover = (
    <Popover id={id} style={{ maxWidth: 380 }}>
      <Popover.Body className="small">
        {tips.length > 0 && (
          <div className="mb-3" data-testid="usage-help-tips">
            <div style={SECTION_TITLE}>{t('usage_help_now')}</div>
            {tips.map((tip) => (
              <div key={tip} className="d-flex gap-2 mb-1">
                <Lightbulb size={13} className="flex-shrink-0 mt-1" style={{ color: '#eb633b' }} aria-hidden="true" />
                <span>{tip}</span>
              </div>
            ))}
          </div>
        )}
        <div style={SECTION_TITLE}>{t('usage_help_keys')}</div>
        <KeyHints hints={hints} vertical active={active} inactiveNote={inactiveNote} />
      </Popover.Body>
    </Popover>
  );

  return (
    <span className="d-inline-flex align-items-center gap-2" data-testid="usage-help">
      <OverlayTrigger trigger={['hover', 'focus']} placement={placement} overlay={popover} delay={{ show: 120, hide: 150 }}>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1 py-0"
          style={{ fontSize: 12, borderRadius: 'var(--progeo-radius-pill)', height: 26 }}
          aria-label={t('usage_help')}
        >
          <Keyboard size={13} aria-hidden="true" />
          {t('usage_help')}
        </button>
      </OverlayTrigger>
      {/* What the last processed key did - gone after a moment. */}
      <span
        aria-live="polite"
        data-testid="usage-help-feedback"
        className="small"
        style={{
          color: '#a3401f',
          opacity: processed ? 1 : 0,
          transition: 'opacity 200ms',
          whiteSpace: 'nowrap',
        }}
      >
        {processed ? `${processed.keys.join(' + ')} · ${processed.label}` : ''}
      </span>
    </span>
  );
};

export default UsageHelp;
