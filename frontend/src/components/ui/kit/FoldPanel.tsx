import { useEffect, useId, useState, type ReactNode } from 'react';
import { Collapse } from 'react-bootstrap';
import { ChevronRight } from 'react-bootstrap-icons';
import './kit.css';
import './FoldPanel.css';

/** The fold toggle's test id - one per panel, told apart by data-test-key (the panel's test id). */
export const FOLD_TOGGLE_TEST_ID = 'fold-toggle';

type FoldPanelProps = {
  /** The header - the toggle's label (a click on it folds / unfolds). */
  title: ReactNode;
  /** A short explanation under the title - shown folded too, so it tells
   * what the panel is for before it is opened. */
  hint?: ReactNode;
  /** Right of the title (counts, buttons) - shown folded too. */
  actions?: ReactNode;
  children: ReactNode;
  /** Unfolded when first shown (default: folded). */
  defaultOpen?: boolean;
  /** Unfolds whenever this turns true (e.g. the step a link pointed at). */
  openOn?: boolean;
  /** data-testid of the panel (src/testIds.ts) - also the toggle's data-test-key. */
  testId?: string;
  /** Element id - an anchor links can jump to (#id). */
  id?: string;
  /** Extra classes of the panel itself (e.g. a highlight). */
  className?: string;
};

/**
 * A PanelCard that folds: the header is a toggle button (aria-expanded,
 * data-testid="fold-toggle", data-test-key = the panel's test id), the body a
 * Bootstrap Collapse. Folded by default. The body stays mounted while folded -
 * its state (forms, a canvas) survives folding.
 *
 * The screenshot capture (e2e/screenshots/capture.mjs) and the UI tests
 * unfold every `[data-testid="fold-toggle"][aria-expanded="false"]` first.
 */
const FoldPanel = ({
  title,
  hint,
  actions,
  children,
  defaultOpen = false,
  openOn = false,
  testId,
  id,
  className,
}: FoldPanelProps) => {
  const [open, setOpen] = useState(defaultOpen || openOn);
  const bodyId = useId();

  useEffect(() => {
    if (openOn) {
      setOpen(true);
    }
  }, [openOn]);

  return (
    <section
      id={id}
      className={['progeo-panel', 'progeo-fold', open ? 'progeo-fold--open' : null, className]
        .filter(Boolean)
        .join(' ')}
      data-testid={testId}
    >
      <div className="progeo-panel-head progeo-fold-head">
        <button
          type="button"
          className="progeo-fold-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
          data-testid={FOLD_TOGGLE_TEST_ID}
          data-test-key={testId}
        >
          <ChevronRight className="progeo-fold-chevron" size={14} aria-hidden />
          <span className="progeo-panel-title">{title}</span>
        </button>
        {actions && (
          <>
            <div className="progeo-panel-spacer" />
            {actions}
          </>
        )}
      </div>
      {hint && (
        <div className="progeo-fold-hint" data-testid={testId ? `${testId}-hint` : undefined}>
          {hint}
        </div>
      )}
      <Collapse in={open}>
        <div id={bodyId}>
          <div className="progeo-panel-body progeo-fold-body">{children}</div>
        </div>
      </Collapse>
    </section>
  );
};

export default FoldPanel;
