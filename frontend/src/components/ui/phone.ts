/**
 * Phone numbers are stored in E.164 (`+4917112345678`). PhoneInput splits
 * them into a country calling code (dropdown) and the national number;
 * these helpers do the parsing and joining. The backend mirror is
 * progeo/helper/phone_numbers.py - keep the rules in step.
 */

export type CallingCode = {
  /** ISO 3166-1 alpha-2, also the label in the dropdown. */
  iso: string;
  /** Calling code digits without "+". */
  dial: string;
};

/** Germany first (the default), then the neighbours, then the rest of Europe and the US. */
export const CALLING_CODES: CallingCode[] = [
  { iso: 'DE', dial: '49' },
  { iso: 'AT', dial: '43' },
  { iso: 'CH', dial: '41' },
  { iso: 'NL', dial: '31' },
  { iso: 'BE', dial: '32' },
  { iso: 'LU', dial: '352' },
  { iso: 'FR', dial: '33' },
  { iso: 'IT', dial: '39' },
  { iso: 'PL', dial: '48' },
  { iso: 'CZ', dial: '420' },
  { iso: 'DK', dial: '45' },
  { iso: 'LI', dial: '423' },
  { iso: 'GB', dial: '44' },
  { iso: 'IE', dial: '353' },
  { iso: 'ES', dial: '34' },
  { iso: 'PT', dial: '351' },
  { iso: 'SE', dial: '46' },
  { iso: 'NO', dial: '47' },
  { iso: 'FI', dial: '358' },
  { iso: 'HU', dial: '36' },
  { iso: 'SK', dial: '421' },
  { iso: 'SI', dial: '386' },
  { iso: 'HR', dial: '385' },
  { iso: 'RO', dial: '40' },
  { iso: 'BG', dial: '359' },
  { iso: 'GR', dial: '30' },
  { iso: 'TR', dial: '90' },
  { iso: 'US', dial: '1' },
];

export const DEFAULT_DIAL = '49';

/** Italy keeps the leading 0 of its national numbers; everywhere else it is the trunk prefix. */
const KEEPS_LEADING_ZERO = new Set(['39']);

const E164 = /^\+[1-9]\d{6,14}$/;

export type PhoneParts = { dial: string; national: string };

const digitsOf = (value: string) => value.replace(/\D/g, '');

/**
 * The calling code at the start of `digits` (international, without "+"):
 * a code of the list, else ITU's rule of thumb (1 for NANP, 7 for Russia,
 * two digits for 2x-9x except the 3-digit zones).
 */
const splitDial = (digits: string): PhoneParts => {
  for (const length of [3, 2, 1]) {
    const dial = digits.slice(0, length);
    if (CALLING_CODES.some((code) => code.dial === dial)) {
      return { dial, national: digits.slice(length) };
    }
  }
  const first = digits[0];
  const length = first === '1' || first === '7' ? 1 : /^(2[1-9]|3[578]|42|5[09]|6[7-9]|8[0578]|9[679])/.test(digits) ? 3 : 2;
  return { dial: digits.slice(0, length), national: digits.slice(length) };
};

/**
 * A stored value -> calling code + national number. Understands E.164,
 * "+49 171 …", "0049 …" and legacy national numbers ("0171 …": the
 * default calling code, the trunk 0 dropped).
 */
export const parsePhone = (value: string | null | undefined, defaultDial: string = DEFAULT_DIAL): PhoneParts => {
  const raw = (value || '').trim();
  if (!raw) {
    return { dial: defaultDial, national: '' };
  }
  const digits = digitsOf(raw);
  if (raw.startsWith('+')) {
    return digits ? splitDial(digits) : { dial: defaultDial, national: '' };
  }
  if (digits.startsWith('00')) {
    return splitDial(digits.slice(2));
  }
  return {
    dial: defaultDial,
    national: KEEPS_LEADING_ZERO.has(defaultDial) ? digits : digits.replace(/^0+/, ''),
  };
};

/**
 * Calling code + what the user typed -> E.164, '' while the number field is
 * empty. A full international number typed or pasted into the number field
 * ("+43 …", "0043 …") wins over the dropdown.
 */
export const toE164 = (dial: string, national: string): string => {
  const raw = national.trim();
  if (raw.startsWith('+') || raw.startsWith('00')) {
    const parts = parsePhone(raw, dial);
    return parts.national ? `+${parts.dial}${parts.national}` : '';
  }
  let digits = digitsOf(raw);
  if (!KEEPS_LEADING_ZERO.has(dial)) {
    digits = digits.replace(/^0+/, '');
  }
  return digits ? `+${dial}${digits}` : '';
};

/** Is `value` a plausible E.164 number (7 to 15 digits)? */
export const isValidE164 = (value: string | null | undefined): boolean => E164.test((value || '').trim());

/** Empty or valid - what a form with an optional phone field may save. */
export const isPhoneSavable = (value: string | null | undefined): boolean => !(value || '').trim() || isValidE164(value);

/** "+49 1711234567": calling code and national number, for display. */
export const formatPhone = (value: string | null | undefined): string => {
  const raw = (value || '').trim();
  if (!isValidE164(raw)) {
    return raw;
  }
  const { dial, national } = parsePhone(raw);
  return `+${dial} ${national}`;
};
