import type { ReactNode } from 'react';
import './kit.css';
import { childTestId } from '../../../testIds';

type ConfirmDialogProps = {
  show: boolean;
  title: ReactNode;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  confirming?: boolean;
  /** data-testid of the dialog; its buttons are "<testId>-confirm" / "<testId>-cancel". */
  testId?: string;
};

/**
 * Centered "Are you sure?" overlay, styled like the mockup's other overlays
 * (UserProfile's drawer, etc.) - a dimmed backdrop plus a panel-bg card.
 * Renders nothing when `show` is false so callers can mount it unconditionally.
 */
const ConfirmDialog = ({
  show,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  danger = true,
  confirming = false,
  testId = 'confirm-dialog',
}: ConfirmDialogProps) => {
  if (!show) {
    return null;
  }

  return (
    <div className="progeo-dialog-backdrop" onClick={confirming ? undefined : onCancel}>
      <div
        className="progeo-dialog"
        role="dialog"
        aria-modal="true"
        data-testid={testId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="progeo-dialog-title">{title}</div>
        <div className="progeo-dialog-message">{message}</div>
        <div className="progeo-dialog-actions">
          <button
            type="button"
            className="progeo-dialog-button"
            onClick={onCancel}
            disabled={confirming}
            data-testid={childTestId(testId, 'cancel')}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`progeo-dialog-button progeo-dialog-button--confirm${danger ? ' progeo-dialog-button--danger' : ''}`}
            onClick={onConfirm}
            disabled={confirming}
            data-testid={childTestId(testId, 'confirm')}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
