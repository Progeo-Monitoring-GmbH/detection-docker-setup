/**
 * Users whose access request still waits for the staff's review (helper/
 * access_requests.py): the JWT carries `is_pending`, and the backend
 * (PendingAccessMiddleware) refuses their requests with 403 and
 * `pending_review: true`. They only get the "being reviewed" panel.
 */

/** The panel of a user awaiting review (PendingReview). */
export const PENDING_REVIEW_PATH = '/zugang/pruefung';

/** True for a user whose access request still waits for the staff's review. */
export const isPendingUser = (user: unknown) =>
  Boolean((user as { is_pending?: boolean } | null)?.is_pending);

/** The backend refused a request because the account still waits for review. */
export const isPendingReviewError = (error: unknown) =>
  Boolean((error as { response?: { data?: { pending_review?: boolean } } })?.response?.data?.pending_review);
