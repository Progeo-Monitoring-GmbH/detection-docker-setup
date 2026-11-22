import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Collapse } from 'react-bootstrap';
import { ChevronRight } from 'react-bootstrap-icons';
import './kit.css';

/** A titled panel higher than this (px) gets a fold toggle. */
export const FOLD_MIN_HEIGHT = 250;

/** The fold toggle's test id - one per panel, told apart by data-test-key (as FoldPanel's). */
const FOLD_TOGGLE_TEST_ID = 'fold-toggle';

type PanelCardProps = {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
  /** Inside another panel: no background, shadow or padding of its own - the
   * outer panel's would double them. */
  flat?: boolean;
  /** Whether the panel folds. Default: a panel with a title folds once it is
   * higher than FOLD_MIN_HEIGHT. true: always, false: never (it folds itself). */
  foldable?: boolean;
  /** The fold state, when the page keeps it (with onToggle). */
  open?: boolean;
  onToggle?: () => void;
  /** data-testid (src/testIds.ts) - UI tests find the element by it. */
  testId?: string;
  /** Element id - an anchor links can jump to (#id). */
  id?: string;
  /** Extra classes of the panel itself (e.g. a highlight). */
  className?: string;
};

/**
 * The rounded, softly-shadowed "#F3F1F0" section wrapper used for every
 * panel in the Portal v2 mockup (KPI strip, Dachansicht, Verdachtsstellen,
 * Objekt sections, ...). Styles: kit.css (.progeo-panel).
 *
 * A panel with a title that is higher than FOLD_MIN_HEIGHT folds: a chevron
 * before its title (data-testid="fold-toggle", data-test-key = the panel's
 * test id) slides the body away (a Bootstrap Collapse, as FoldPanel's). It
 * starts unfolded, and the body stays mounted
 * while folded - its state (forms, a canvas) survives. Only the chevron is the
 * button: a title may hold controls of its own.
 */
const PanelCard = ({
  title,
  actions,
  children,
  bodyClassName,
  flat = false,
  foldable,
  open,
  onToggle,
  testId,
  id,
  className,
}: PanelCardProps) => {
  const panel = useRef<HTMLElement>(null);
  const ownId = useId();
  const [tall, setTall] = useState(false);
  const [ownOpen, setOwnOpen] = useState(true);
  const hasTitle = !!title;
  const measured = foldable === undefined && hasTitle && !flat;

  // Once higher than the limit it stays foldable - folded it is lower again.
  useEffect(() => {
    const element = panel.current;
    if (!measured || tall || !element || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const check = () => {
      if (element.offsetHeight > FOLD_MIN_HEIGHT) {
        setTall(true);
      }
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measured, tall]);

  const folds = hasTitle && (foldable ?? (measured && tall));
  const isOpen = !folds || (open ?? ownOpen);
  const bodyId = `${ownId}-body`;
  const titleId = `${ownId}-title`;

  return (
    <section
      ref={panel}
      id={id}
      className={[flat ? 'progeo-panel progeo-panel--flat' : 'progeo-panel', className].filter(Boolean).join(' ')}
      data-testid={testId}
    >
      {(title || actions) && (
        <div className="progeo-panel-head">
          {folds && (
            <button
              type="button"
              className={isOpen ? 'progeo-panel-fold progeo-panel-fold--open' : 'progeo-panel-fold'}
              aria-expanded={isOpen}
              aria-controls={bodyId}
              aria-labelledby={titleId}
              onClick={onToggle ?? (() => setOwnOpen((value) => !value))}
              data-testid={FOLD_TOGGLE_TEST_ID}
              data-test-key={testId ?? id ?? ownId}
            >
              <ChevronRight size={14} aria-hidden />
            </button>
          )}
          {title && (
            <div className="progeo-panel-title" id={titleId}>
              {title}
            </div>
          )}
          <div className="progeo-panel-spacer" />
          {actions}
        </div>
      )}
      {/* Always there, so a panel that starts to fold keeps its children mounted. */}
      <Collapse in={isOpen}>
        <div id={bodyId} className="progeo-panel-fold-body">
          <div className={bodyClassName ? `progeo-panel-body ${bodyClassName}` : 'progeo-panel-body'}>{children}</div>
        </div>
      </Collapse>
    </section>
  );
};

export default PanelCard;
