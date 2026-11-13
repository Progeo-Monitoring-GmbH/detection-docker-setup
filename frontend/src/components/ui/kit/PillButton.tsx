import type { ReactNode } from 'react';
import './kit.css';

type PillButtonProps = {
  label: ReactNode;
  onClick: () => void;
  active?: boolean;
  variant?: 'solid' | 'ghost' | 'accent';
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
  /** data-testid (src/testIds.ts) - UI tests find the element by it. */
  testId?: string;
  /** Tells copies of a repeated button apart (data-test-key, src/testIds.ts). */
  testKey?: string;
};

/**
 * The pill-shaped segment/filter button used throughout the mockup (role
 * switcher, roof-view toggle, sequence controls, ...). `active` styles it as
 * the selected option inside a SegmentedControl track; `variant="solid"`
 * (default) is a standalone pill button on its own (e.g. "Alle ansehen").
 * `variant="accent"` is a filled ProGeo-orange action button - for actions
 * that must stand out on a panel (the device commands). Styles: kit.css.
 */
const PillButton = ({
  label,
  onClick,
  active = false,
  variant = 'solid',
  icon,
  disabled = false,
  title,
  testId,
  testKey,
}: PillButtonProps) => {
  const classes = ['progeo-pill', `progeo-pill--${variant}`, active ? 'progeo-pill--active' : ''];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={classes.filter(Boolean).join(' ')}
      data-testid={testId}
      data-test-key={testKey}
      aria-pressed={variant !== 'accent' && active ? true : undefined}
    >
      {icon}
      {label}
    </button>
  );
};

export default PillButton;
