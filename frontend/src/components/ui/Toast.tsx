import { forwardRef, type CSSProperties } from 'react';
import {
  CheckCircleFill,
  ExclamationTriangleFill,
  InfoCircleFill,
  XCircleFill,
  XLg,
} from 'react-bootstrap-icons';
import { SnackbarContent, useSnackbar, type CustomContentProps, type VariantType } from 'notistack';
import { useTranslation } from 'react-i18next';
import './Toast.css';

/** How long a toast stays (ms) unless the call sets autoHideDuration -
 * errors longest, they need reading. */
export const TOAST_DURATION: Record<VariantType, number> = {
  default: 5000,
  success: 3500,
  info: 5000,
  warning: 6500,
  error: 8000,
};

const COLOR: Record<VariantType, string> = {
  default: '#094b81',
  success: '#3F7A1C',
  info: '#094b81',
  warning: '#eb633b',
  error: '#C0392B',
};

const ICON: Record<VariantType, typeof InfoCircleFill> = {
  default: InfoCircleFill,
  success: CheckCircleFill,
  info: InfoCircleFill,
  warning: ExclamationTriangleFill,
  error: XCircleFill,
};

/**
 * Every toast of the app (notistack's content component for all variants,
 * see App.tsx): a click anywhere closes it, the bar at the bottom runs down
 * the time until it closes on its own - paused while the pointer is on it,
 * so a long message can be read. The timer is the bar's animation
 * (onAnimationEnd closes), so bar and closing can't drift apart; notistack's
 * own timer is off (autoHideDuration null in the provider). `persist`
 * toasts have no bar and stay until clicked.
 */
const Toast = forwardRef<HTMLDivElement, CustomContentProps>(
  ({ id, message, variant, persist, autoHideDuration, style, className }, ref) => {
    const { t } = useTranslation();
    const { closeSnackbar } = useSnackbar();
    const close = () => closeSnackbar(id);
    const duration = autoHideDuration ?? TOAST_DURATION[variant];
    const Icon = ICON[variant];

    return (
      <SnackbarContent ref={ref} role={variant === 'error' ? 'alert' : 'status'} style={style} className={className}>
        <div
          className="progeo-toast"
          data-testid="toast"
          style={{ '--toast-color': COLOR[variant] } as CSSProperties}
          onClick={close}
          title={t('toast_click_to_close')}
        >
          <Icon className="progeo-toast-icon" size={18} />
          <div className="progeo-toast-message">{message}</div>
          <button
            type="button"
            className="progeo-toast-close"
            aria-label={t('toast_close')}
            onClick={(event) => {
              event.stopPropagation();
              close();
            }}
          >
            <XLg size={12} />
          </button>
          {!persist && (
            <div
              className="progeo-toast-progress"
              data-testid="toast-progress"
              style={{ animationDuration: `${duration}ms` }}
              onAnimationEnd={close}
            />
          )}
        </div>
      </SnackbarContent>
    );
  },
);

Toast.displayName = 'Toast';

export default Toast;
