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

// Machine-readable `code` of the profile/2FA endpoints' failures
// (user_profile_viewset._failed) -> i18n key.
const ERROR_CODE_KEYS: Record<string, string> = {
  invalid_code: 'login_otp_invalid',
  wrong_password: 'tfa_password_wrong',
  mandatory_for_staff: 'tfa_required_hint',
  already_enabled: 'tfa_already_enabled',
  two_factor_required: 'profile_set_password_needs_2fa',
  weak_password: 'profile_password_weak',
  missing_fields: 'profile_password_missing',
};

// Django's password validators (password_codes of code "password_invalid").
const PASSWORD_RULE_KEYS: Record<string, string> = {
  password_too_short: 'password_rule_too_short',
  password_too_common: 'password_rule_too_common',
  password_entirely_numeric: 'password_rule_entirely_numeric',
  password_too_similar: 'password_rule_too_similar',
};

/**
 * The translated text of a failed profile/2FA request: by the backend's
 * `code`, else its (English) `reason`, else `fallback`.
 */
export const serverErrorText = (
  t: (key: string) => string,
  error: unknown,
  fallback: string,
): string => {
  const data = (
    error as { response?: { data?: { code?: string; reason?: string; password_codes?: string[] } } }
  )?.response?.data;
  if (data?.code === 'password_invalid' && data.password_codes?.length) {
    return data.password_codes
      .map((code) => (PASSWORD_RULE_KEYS[code] ? t(PASSWORD_RULE_KEYS[code]) : code))
      .join(' ');
  }
  if (data?.code && ERROR_CODE_KEYS[data.code]) {
    return t(ERROR_CODE_KEYS[data.code]);
  }
  return data?.reason || fallback;
};
