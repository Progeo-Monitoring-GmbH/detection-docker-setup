import { type ReactNode, useId, useState } from 'react';

type TooltipProps = {
  title: string;
  children: ReactNode;
};

/**
 * Small CSS-only hover tooltip for abbreviation headers (MPkt./AVGWP/LVL),
 * matching the mockup's own look: dotted underline, cursor:help. No new
 * dependency (antd/MUI tooltip components were deliberately not added to
 * the kit) - a plain positioned span is enough for this use case.
 */
const Tooltip = ({ title, children }: TooltipProps) => {
  const [visible, setVisible] = useState(false);
  const tooltipId = useId();

  return (
    <span
      style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      <span
        tabIndex={0}
        aria-describedby={tooltipId}
        style={{
          cursor: 'help',
          borderBottom: '1px dotted #B8B0B0',
        }}
      >
        {children}
      </span>
      {visible && (
        <span
          role="tooltip"
          id={tooltipId}
          style={{
            position: 'absolute',
            top: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginTop: 6,
            background: '#07223A',
            color: '#fff',
            fontSize: 12,
            fontWeight: 400,
            borderRadius: 6,
            padding: '6px 10px',
            whiteSpace: 'nowrap',
            boxShadow: '0 6px 18px rgba(11, 54, 89, .25)',
            zIndex: 100,
          }}
        >
          {title}
        </span>
      )}
    </span>
  );
};

export default Tooltip;
