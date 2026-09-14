import type { ReactNode } from 'react';

type PanelCardProps = {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
};

/**
 * The rounded, softly-shadowed "#F3F1F0" section wrapper used for every
 * panel in the Portal v2 mockup (KPI strip, Dachansicht, Verdachtsstellen,
 * Objekt sections, ...).
 */
const PanelCard = ({ title, actions, children, bodyClassName }: PanelCardProps) => {
  return (
    <section
      style={{
        background: 'var(--progeo-panel-bg)',
        borderRadius: 'var(--progeo-radius-panel)',
        boxShadow: 'var(--progeo-shadow-panel)',
        overflow: 'hidden',
      }}
    >
      {(title || actions) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '18px 20px 12px',
            flexWrap: 'wrap',
          }}
        >
          {title && <div style={{ fontSize: 16, fontWeight: 500 }}>{title}</div>}
          <div style={{ flex: 1, minWidth: 8 }} />
          {actions}
        </div>
      )}
      <div className={bodyClassName} style={{ padding: title || actions ? '0 20px 18px' : 20 }}>
        {children}
      </div>
    </section>
  );
};

export default PanelCard;
