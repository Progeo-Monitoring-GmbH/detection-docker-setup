import type { ReactNode } from 'react';
import './kit.css';

type PanelCardProps = {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
  /** Inside another panel: no background, shadow or padding of its own - the
   * outer panel's would double them. */
  flat?: boolean;
  /** data-testid (src/testIds.ts) - UI tests find the element by it. */
  testId?: string;
};

/**
 * The rounded, softly-shadowed "#F3F1F0" section wrapper used for every
 * panel in the Portal v2 mockup (KPI strip, Dachansicht, Verdachtsstellen,
 * Objekt sections, ...). Styles: kit.css (.progeo-panel).
 */
const PanelCard = ({ title, actions, children, bodyClassName, flat = false, testId }: PanelCardProps) => (
  <section className={flat ? 'progeo-panel progeo-panel--flat' : 'progeo-panel'} data-testid={testId}>
    {(title || actions) && (
      <div className="progeo-panel-head">
        {title && <div className="progeo-panel-title">{title}</div>}
        <div className="progeo-panel-spacer" />
        {actions}
      </div>
    )}
    <div className={bodyClassName ? `progeo-panel-body ${bodyClassName}` : 'progeo-panel-body'}>{children}</div>
  </section>
);

export default PanelCard;
