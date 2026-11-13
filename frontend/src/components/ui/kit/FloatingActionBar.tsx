import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Spinner } from 'react-bootstrap';
import { childTestId } from '../../../testIds';
import './FloatingActionBar.css';

export type FloatingAction = {
  label: ReactNode;
  onClick: () => void;
  /** primary: the main action (save, apply); danger: it deletes; secondary: cancel/discard. */
  variant?: 'primary' | 'danger' | 'secondary';
  disabled?: boolean;
  /** Shows a spinner on the button (and disables it). */
  busy?: boolean;
  /** Overrides the button colour (e.g. the colour of a canvas mode). */
  color?: string;
  icon?: ReactNode;
  testId?: string;
};

const HOST_ID = 'progeo-floating-actions';

/** The one container every bar is portalled into - several pending actions stack. */
const host = () => {
  let element = document.getElementById(HOST_ID);
  if (!element) {
    element = document.createElement('div');
    element.id = HOST_ID;
    element.className = 'progeo-floating-actions';
    element.setAttribute('role', 'region');
    element.setAttribute('aria-label', 'Pending actions');
    document.body.appendChild(element);
  }
  return element;
};

/**
 * A pending action the user must not miss (save, apply, confirm): floats at
 * the bottom of the window, above the page, with big buttons - shown only
 * while there is something to apply. Rendered while mounted; several stack.
 */
const FloatingActionBar = ({
  message,
  detail,
  actions,
  tone = 'primary',
  testId,
}: {
  /** What is pending, e.g. "3 sensors placed - not saved yet". */
  message: ReactNode;
  /** A second, smaller line (e.g. what saving replaces). */
  detail?: ReactNode;
  /** Left to right: the main action last. */
  actions: FloatingAction[];
  /** The bar's accent (its left edge). */
  tone?: 'primary' | 'danger' | 'warning';
  testId?: string;
}) => {
  // host() is idempotent - safe in the initializer (also when run twice).
  const [target] = useState<HTMLElement | null>(() => (typeof document !== 'undefined' ? host() : null));
  if (!target) {
    return null;
  }
  return createPortal(
    <div className={`progeo-floating-bar progeo-floating-bar--${tone}`} aria-live="polite" data-testid={testId}>
      <div className="progeo-floating-text">
        <div className="progeo-floating-message" data-testid={childTestId(testId, 'message')}>{message}</div>
        {detail && <div className="progeo-floating-detail">{detail}</div>}
      </div>
      <div className="progeo-floating-buttons">
        {actions.map((action, index) => (
          <button
            key={index}
            type="button"
            className={`progeo-floating-button progeo-floating-button--${action.variant ?? 'primary'}`}
            style={action.color ? { background: action.color, borderColor: action.color, color: '#ffffff' } : undefined}
            disabled={action.disabled || action.busy}
            onClick={action.onClick}
            data-testid={action.testId}
          >
            {action.busy ? <Spinner animation="border" size="sm" aria-hidden /> : action.icon}
            <span>{action.label}</span>
          </button>
        ))}
      </div>
    </div>,
    target,
  );
};

export default FloatingActionBar;
