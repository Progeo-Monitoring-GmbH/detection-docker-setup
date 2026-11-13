import type { MouseEvent } from 'react';
import { Trash } from 'react-bootstrap-icons';
import './kit.css';

type DeleteIconButtonProps = {
  /** What the button does ("Delete device") - shown on hover and read by screen readers. */
  label: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  disabled?: boolean;
  /** Renders a link instead (e.g. to the Django admin's delete page). */
  href?: string;
  target?: string;
};

const CLASS_NAME = 'progeo-icon-button progeo-icon-button--danger';

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
      className={CLASS_NAME}
    >
      <Trash size={14} />
    </a>
  ) : (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className={CLASS_NAME}>
      <Trash size={14} />
    </button>
  );

export default DeleteIconButton;
