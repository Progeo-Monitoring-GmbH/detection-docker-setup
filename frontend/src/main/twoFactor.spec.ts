import { describe, expect, it } from 'vitest';
import {
  isTwoFactorSetupError,
  needsTwoFactorSetup,
  otpReason,
  recoveryCodesText,
} from './twoFactor';

const failed = (status: number, data: unknown) => ({ response: { status, data } });

describe('needsTwoFactorSetup', () => {
  it('reads the JWT claim', () => {
    expect(needsTwoFactorSetup({ two_factor_setup_required: true })).toBe(true);
    expect(needsTwoFactorSetup({ two_factor_setup_required: false })).toBe(false);
    expect(needsTwoFactorSetup({})).toBe(false);
    expect(needsTwoFactorSetup(null)).toBe(false);
  });
});

describe('isTwoFactorSetupError', () => {
  it('recognizes the middleware answer', () => {
    expect(isTwoFactorSetupError(failed(403, { two_factor_setup_required: true }))).toBe(true);
    expect(isTwoFactorSetupError(failed(403, { reason: 'nope' }))).toBe(false);
    expect(isTwoFactorSetupError(new Error('Network Error'))).toBe(false);
  });
});

describe('otpReason', () => {
  it('handles the token endpoint (401, stringified flag)', () => {
    expect(
      otpReason(failed(401, { detail: 'Two-factor code required', reason: 'otp_required', otp_required: 'True' })),
    ).toBe('otp_required');
    expect(otpReason(failed(401, { reason: 'otp_invalid', otp_required: 'True' }))).toBe('otp_invalid');
  });

  it('handles the auth-support endpoints (400, boolean flag)', () => {
    expect(otpReason(failed(400, { success: false, reason: 'otp_invalid', otp_required: true }))).toBe(
      'otp_invalid',
    );
  });

  it('is null for every other failure', () => {
    expect(otpReason(failed(401, { detail: 'No active account found' }))).toBeNull();
    expect(otpReason(failed(400, { reason: 'invalid_token' }))).toBeNull();
    expect(otpReason(new Error('Network Error'))).toBeNull();
    expect(otpReason(undefined)).toBeNull();
  });
});

describe('recoveryCodesText', () => {
  it('lists one code per line below the title', () => {
    expect(recoveryCodesText('Codes', ['abcde-fghjk', 'klmno-pqrst'])).toBe(
      'Codes\n\nabcde-fghjk\nklmno-pqrst\n',
    );
  });
});
