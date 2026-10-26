/**
 * Two-factor authentication (TOTP, helper/two_factor.py in the backend).
 * A login with password or login link asks for the code from the
 * authenticator app as a second step; staff may be forced to set it up
 * first (TWO_FACTOR_REQUIRED_FOR_STAFF) - their JWT then carries the claim
 * `two_factor_setup_required` and the backend refuses everything but the
 * profile (TwoFactorRequiredMiddleware), see TwoFactorSetupRequired.
 */

/** The only page of a user who has to set up 2FA first. */
export const TWO_FACTOR_SETUP_PATH = '/konto/zwei-faktor';

/** JWT claim `two_factor_setup_required` (ProgeoTokenObtainPairSerializer). */
export const needsTwoFactorSetup = (user: unknown) =>
  Boolean(
    (user as { two_factor_setup_required?: boolean } | null)
      ?.two_factor_setup_required,
  );

/** A request the backend refused because 2FA has to be set up first. */
export const isTwoFactorSetupError = (error: unknown) =>
  Boolean(
    (
      error as {
        response?: { data?: { two_factor_setup_required?: boolean } };
      }
    )?.response?.data?.two_factor_setup_required,
  );

export type OtpReason = 'otp_required' | 'otp_invalid';

/**
 * "otp_required"/"otp_invalid" when a login (token, login link, password
 * reset) failed only for the missing or wrong 2FA code, else null. The token
 * endpoint answers 401 with `otp_required: "True"` (DRF stringifies it), the
 * auth-support endpoints 400 with `otp_required: true`.
 */
export const otpReason = (error: unknown): OtpReason | null => {
  const data = (
    error as {
      response?: { data?: { reason?: unknown; otp_required?: unknown } };
    }
  )?.response?.data;
  if (!data?.otp_required) {
    return null;
  }
  return data.reason === 'otp_invalid' ? 'otp_invalid' : 'otp_required';
};

/** Content of the recovery codes' .txt download. */
export const recoveryCodesText = (title: string, codes: string[]) =>
  `${title}\n\n${codes.join('\n')}\n`;
