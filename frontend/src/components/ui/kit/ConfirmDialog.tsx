import type { ReactNode } from 'react';

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
}: ConfirmDialogProps) => {
  if (!show) {
    return null;
  }

  return (
    <div
      onClick={confirming ? undefined : onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(7, 34, 58, .38)',
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 380,
          background: 'var(--progeo-panel-bg)',
          borderRadius: 18,
          boxShadow: '0 20px 60px rgba(11, 54, 89, .3)',
          padding: 22,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--progeo-blue)' }}>
          {title}
        </div>
        <div style={{ fontSize: 13.5, color: '#6E6868', lineHeight: 1.5 }}>{message}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={confirming}
            style={{
              height: 38,
              padding: '0 16px',
              border: 'none',
              borderRadius: 10,
              background: 'var(--progeo-surface)',
              boxShadow: '0 2px 8px rgba(11, 54, 89, .1)',
              color: 'var(--progeo-blue)',
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 500,
              cursor: confirming ? 'default' : 'pointer',
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming}
            style={{
              height: 38,
              padding: '0 18px',
              border: 'none',
              borderRadius: 10,
              background: danger ? '#C44D26' : 'var(--progeo-orange)',
              color: '#fff',
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 500,
              cursor: confirming ? 'default' : 'pointer',
              boxShadow: '0 4px 14px rgba(196, 77, 38, .28)',
              opacity: confirming ? 0.7 : 1,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
