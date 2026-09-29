export function showSuccessBar(enqueueSnackbar, msg) {
  enqueueSnackbar(msg, { variant: 'success' });
}

export function showErrorBar(enqueueSnackbar, msg) {
  enqueueSnackbar(msg, { variant: 'error' });
}

export function showInfoBar(enqueueSnackbar, msg) {
  enqueueSnackbar(msg, { variant: 'info' });
}

/** The backend's `reason` for a failed request, else the transport error. */
export const errorReason = (error) => error?.response?.data?.reason || error?.message;

/** Shows "<prefix>: <reason>" for a failed request. */
export function showRequestError(enqueueSnackbar, prefix, error) {
  showErrorBar(enqueueSnackbar, `${prefix}: ${errorReason(error)}`);
}
