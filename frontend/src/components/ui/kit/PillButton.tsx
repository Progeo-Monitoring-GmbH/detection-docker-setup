import type { ReactNode } from 'react';

type PillButtonProps = {
  label: ReactNode;
  onClick: () => void;
  active?: boolean;
  variant?: 'solid' | 'ghost';
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
};

/**
 * The pill-shaped segment/filter button used throughout the mockup (role
 * switcher, roof-view toggle, sequence controls, ...). `active` styles it as
 * the selected option inside a SegmentedControl track; `variant="solid"`
 * (default) is a standalone pill button on its own (e.g. "Alle ansehen").
 */
const PillButton = ({
  label,
  onClick,
  active = false,
  variant = 'solid',
  icon,
  disabled = false,
  title,
}: PillButtonProps) => {
  const isGhost = variant === 'ghost' && !active;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        height: 32,
        padding: '0 14px',
        border: 'none',
        borderRadius: 'var(--progeo-radius-pill)',
        background: active ? 'var(--progeo-surface)' : 'transparent',
        boxShadow: active ? 'var(--progeo-shadow-chrome)' : 'none',
        color: isGhost ? '#6E6868' : 'var(--progeo-blue)',
        fontFamily: 'inherit',
        fontSize: 12.5,
        fontWeight: 500,
        cursor: disabled ? 'default' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon}
      {label}
    </button>
  );
};

export default PillButton;
