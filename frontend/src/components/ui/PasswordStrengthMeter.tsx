import { ProgressBar } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { childTestId } from '../../testIds';

export type PasswordStrength = {
  score: number;
  level: 'very_weak' | 'weak' | 'medium' | 'strong' | 'very_strong';
  /** Good enough to be stored - the backend's rule (helper/password_rules.py). */
  valid: boolean;
  checks: {
    minLength: boolean;
    lower: boolean;
    upper: boolean;
    digit: boolean;
    special: boolean;
    multipleCharsets: boolean;
  };
};

/**
 * How strong a password is. Valid - as the backend requires
 * (password_rules.is_minimally_strong) - from 8 characters with at least
 * three of: lower case, upper case, digits, special characters. The score
 * (0-6) only drives the bar.
 */
export const evaluatePasswordStrength = (
  password: string,
): PasswordStrength => {
  const checks = {
    minLength: password.length >= 8,
    lower: /[a-z]/.test(password),
    upper: /[A-Z]/.test(password),
    digit: /\d/.test(password),
    special: /[^A-Za-z0-9]/.test(password),
    multipleCharsets: false,
  };
  const charsetCount = [
    checks.lower,
    checks.upper,
    checks.digit,
    checks.special,
  ].filter(Boolean).length;
  checks.multipleCharsets = charsetCount >= 3;

  const score = [
    checks.minLength,
    checks.lower,
    checks.upper,
    checks.digit,
    checks.special,
    checks.multipleCharsets,
  ].filter(Boolean).length;

  let level: PasswordStrength['level'] = 'very_weak';
  if (score >= 6) {
    level = 'very_strong';
  } else if (score >= 5) {
    level = 'strong';
  } else if (score >= 4) {
    level = 'medium';
  } else if (score >= 3) {
    level = 'weak';
  }
  return {
    score,
    level,
    valid: checks.minLength && checks.multipleCharsets,
    checks,
  };
};

const VARIANT_BY_LEVEL: Record<PasswordStrength['level'], string> = {
  very_weak: 'danger',
  weak: 'danger',
  medium: 'warning',
  strong: 'info',
  very_strong: 'success',
};

/**
 * The strength of a new password while it is typed: a bar with the level and
 * the two requirements, ticked off once met. Used wherever a password is set
 * (the profile, "Add user" on /staff/) - the field itself stays the form's.
 * Parts: "<testId>-strength", "-strength-level", "-min-length", "-charset".
 */
const PasswordStrengthMeter = ({
  password,
  testId,
}: {
  password: string;
  testId?: string;
}) => {
  const { t } = useTranslation();
  const strength = evaluatePasswordStrength(password);
  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-1">
        <small className="text-muted">{t('profile_password_strength')}</small>
        <small data-testid={childTestId(testId, 'strength-level')}>
          {t(`profile_password_strength_${strength.level}`)}
        </small>
      </div>
      <ProgressBar
        now={(strength.score / 6) * 100}
        variant={VARIANT_BY_LEVEL[strength.level]}
        data-testid={childTestId(testId, 'strength')}
      />
      <small className="text-muted d-block mt-2">
        {t('profile_password_requirements_hint')}
      </small>
      <small
        className="d-block mt-1"
        data-testid={childTestId(testId, 'min-length')}
      >
        {strength.checks.minLength
          ? t('profile_password_requirement_min_length_ok')
          : t('profile_password_requirement_min_length')}
      </small>
      <small className="d-block" data-testid={childTestId(testId, 'charset')}>
        {strength.checks.multipleCharsets
          ? t('profile_password_requirement_charset_ok')
          : t('profile_password_requirement_charset')}
      </small>
    </div>
  );
};

export default PasswordStrengthMeter;
