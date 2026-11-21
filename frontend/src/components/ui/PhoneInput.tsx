import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { childTestId } from '../../testIds';
import { CALLING_CODES, DEFAULT_DIAL, formatPhone, isValidE164, parsePhone, toE164 } from './phone';
import './kit/kit.css';
import './PhoneInput.css';

type PhoneInputProps = {
  label: string;
  /** The stored number - E.164, or a legacy value that is parsed as well as possible. */
  value: string;
  /** Called with E.164 ('' while the number field is empty). */
  onChange?: (value: string) => void;
  readOnly?: boolean;
  required?: boolean;
  /** 'field': the kit look (LabeledInput); 'auth': the sign-in pages (Auth.css); 'bootstrap': Form.Control. */
  variant?: 'field' | 'auth' | 'bootstrap';
  /** Calling code for an empty or national-only value. */
  defaultDial?: string;
  /** Appended to the label, e.g. "(optional)". */
  labelSuffix?: string;
  /** data-testid of the number input; the dropdown is "<testId>-country", the hint "<testId>-invalid". */
  testId?: string;
};

/**
 * Phone number field: a country calling code dropdown plus the national
 * number, stored as E.164 (`+4917112345678`, see ./phone.ts). Used for every
 * phone number of the portal (Mein Konto, notification channel, object
 * contact, access request). Shows a hint while the number is implausible;
 * forms check isPhoneSavable() before saving.
 */
const PhoneInput = ({
  label,
  value,
  onChange,
  readOnly = false,
  required = false,
  variant = 'field',
  defaultDial = DEFAULT_DIAL,
  labelSuffix,
  testId,
}: PhoneInputProps) => {
  const { t } = useTranslation();
  const labelId = useId();
  const [parts, setParts] = useState(() => parsePhone(value, defaultDial));
  // The value this field emitted last: a different one came from outside
  // (loaded, reset) and is parsed again; our own must not reformat the input.
  const emitted = useRef<string | null>(null);

  useEffect(() => {
    if (value !== emitted.current) {
      setParts(parsePhone(value, defaultDial));
      emitted.current = value;
    }
  }, [value, defaultDial]);

  const emit = (dial: string, national: string) => {
    setParts({ dial, national });
    const next = toE164(dial, national);
    emitted.current = next;
    onChange?.(next);
  };

  const CLASSES = {
    field: { wrapper: 'progeo-field', label: 'progeo-field-label', input: 'progeo-field-input', select: 'progeo-field-input' },
    auth: { wrapper: 'auth-label', label: 'progeo-field-label', input: 'progeo-control auth-field', select: 'progeo-control auth-field' },
    bootstrap: { wrapper: '', label: 'form-label', input: 'form-control', select: 'form-select' },
  }[variant];
  const inputClass = CLASSES.input;
  const labelClass = CLASSES.label;
  const current = toE164(parts.dial, parts.national);
  const invalid = Boolean(parts.national.trim()) && !isValidE164(current);
  // A stored number with a calling code outside the list keeps its code.
  const codes = CALLING_CODES.some((code) => code.dial === parts.dial)
    ? CALLING_CODES
    : [...CALLING_CODES, { iso: '', dial: parts.dial }];

  if (readOnly) {
    return (
      <div className={CLASSES.wrapper || undefined}>
        <span id={labelId} className={labelClass}>{label}</span>
        <input
          type="tel"
          value={formatPhone(value)}
          readOnly
          aria-labelledby={labelId}
          className={inputClass}
          data-testid={testId}
        />
      </div>
    );
  }

  return (
    <div className={CLASSES.wrapper || undefined}>
      <span id={labelId} className={labelClass}>
        {label}
        {labelSuffix ? ` ${labelSuffix}` : ''}
      </span>
      <div className="phone-input">
        <select
          value={parts.dial}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => emit(event.target.value, parts.national)}
          aria-label={t('phone_country_code')}
          className={`${CLASSES.select} phone-input-country`}
          data-testid={childTestId(testId, 'country')}
        >
          {codes.map((code) => (
            <option key={code.dial} value={code.dial}>
              {code.iso ? `${code.iso} +${code.dial}` : `+${code.dial}`}
            </option>
          ))}
        </select>
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          value={parts.national}
          required={required}
          placeholder={t('phone_number_placeholder')}
          aria-labelledby={labelId}
          aria-invalid={invalid || undefined}
          onChange={(event: ChangeEvent<HTMLInputElement>) => emit(parts.dial, event.target.value)}
          className={`${inputClass} phone-input-number${invalid ? ' phone-input-number--invalid' : ''}`}
          data-testid={testId}
        />
      </div>
      {invalid && (
        <span className="phone-input-hint" data-testid={childTestId(testId, 'invalid')}>
          {t('phone_invalid')}
        </span>
      )}
    </div>
  );
};

export default PhoneInput;
