import i18n from '../../i18n.jsx';
import { isDemoReadOnlyError } from '../../main/demo';

export function showSuccessBar(enqueueSnackbar, msg) {
  enqueueSnackbar(msg, { variant: 'success' });
}

// > 0 while axiosConfig runs the error callback of a request refused with
// 403: that refusal gets one toast of its own (axiosConfig), the caller's
// "Could not ...: <reason>" would be a second one.
let errorToastsMuted = 0;

/**
 * Runs `callback` with showErrorBar()/showRequestError() silent - for the
 * central 403 toast (axiosConfig.handle), which replaces the caller's.
 */
export function withoutErrorToasts(callback) {
  errorToastsMuted += 1;
  try {
    return callback();
  } finally {
    errorToastsMuted -= 1;
  }
}

export function showErrorBar(enqueueSnackbar, msg) {
  if (errorToastsMuted > 0) {
    return;
  }
  enqueueSnackbar(msg, { variant: 'error' });
}

export function showInfoBar(enqueueSnackbar, msg) {
  enqueueSnackbar(msg, { variant: 'info' });
}

/** The backend's `reason` for a failed request, else the transport error. */
export const errorReason = (error) =>
  isDemoReadOnlyError(error)
    ? i18n.t('demo_read_only')
    : error?.response?.data?.reason || error?.message;

// 403 reasons that only say "refused" - the generic text says it better.
const GENERIC_FORBIDDEN_REASONS = new Set(
  [
    'Missing required permissions',
    'You do not have permission to perform this action.',
    'Forbidden',
    'Permission denied',
    'Just no!',
  ].map((reason) => reason.toLowerCase()),
);

/**
 * The toast text for a request refused with 403: "No permission: <reason>"
 * when the backend names one that says something ("Staff access required"),
 * else the generic "You don't have permission for this.".
 */
export function permissionDeniedMessage(error) {
  const data = error?.response?.data;
  const raw = data?.reason || data?.detail;
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (!reason || GENERIC_FORBIDDEN_REASONS.has(reason.toLowerCase())) {
    return i18n.t('permission_denied');
  }
  return i18n.t('permission_denied_reason', { reason });
}

/** Shows "<prefix>: <reason>" for a failed request. */
export function showRequestError(enqueueSnackbar, prefix, error) {
  showErrorBar(enqueueSnackbar, `${prefix}: ${errorReason(error)}`);
}
