import type { CSSProperties, MouseEvent } from 'react';
import { Trash } from 'react-bootstrap-icons';

type DeleteIconButtonProps = {
  /** What the button does ("Delete device") - shown on hover and read by screen readers. */
  label: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  disabled?: boolean;
  /** Renders a link instead (e.g. to the Django admin's delete page). */
  href?: string;
  target?: string;
};

const RED = '#C44D26';

const style = (disabled: boolean): CSSProperties => ({
  width: 30,
  height: 30,
  flexShrink: 0,
  border: 'none',
  borderRadius: 9,
  background: 'var(--progeo-surface)',
  boxShadow: '0 2px 8px rgba(11, 54, 89, .12)',
  color: RED,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.4 : 1,
  padding: 0,
  textDecoration: 'none',
});

/**
 * The delete / remove action of a row: a trash icon instead of a "Delete"
 * text button, its label as hover text (title) and accessible name. Bulk
 * actions with a count and confirm-dialog buttons keep their text.
 */
const DeleteIconButton = ({ label, onClick, disabled = false, href, target }: DeleteIconButtonProps) =>
  href && !disabled ? (
    <a
      href={href}
      target={target}
      rel={target === '_blank' ? 'noopener noreferrer' : undefined}
      title={label}
      aria-label={label}
      onClick={onClick}
      style={style(false)}
    >
      <Trash size={14} />
    </a>
  ) : (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} style={style(disabled)}>
      <Trash size={14} />
    </button>
  );

export default DeleteIconButton;
