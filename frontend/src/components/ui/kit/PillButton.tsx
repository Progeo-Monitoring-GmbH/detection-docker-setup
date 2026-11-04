import type { ReactNode } from 'react';

type PillButtonProps = {
  label: ReactNode;
  onClick: () => void;
  active?: boolean;
  variant?: 'solid' | 'ghost' | 'accent';
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
};

/**
 * The pill-shaped segment/filter button used throughout the mockup (role
 * switcher, roof-view toggle, sequence controls, ...). `active` styles it as
 * the selected option inside a SegmentedControl track; `variant="solid"`
 * (default) is a standalone pill button on its own (e.g. "Alle ansehen").
 * `variant="accent"` is a filled ProGeo-orange action button - for actions
 * that must stand out on a panel (the device commands).
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
  const isAccent = variant === 'accent' && !active;
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
        background: active
          ? 'var(--progeo-surface)'
          : isAccent
            ? 'var(--progeo-orange)'
            : 'transparent',
        boxShadow: active || isAccent ? 'var(--progeo-shadow-chrome)' : 'none',
        color: isAccent ? 'var(--progeo-white)' : isGhost ? '#6E6868' : 'var(--progeo-blue)',
        fontFamily: 'inherit',
        fontSize: 12.5,
        fontWeight: isAccent ? 600 : 500,
        cursor: disabled ? 'default' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        opacity: disabled ? 0.5 : 1,
        ...(isAccent ? { whiteSpace: 'nowrap' as const } : {}),
      }}
    >
      {icon}
      {label}
    </button>
  );
};

export default PillButton;
