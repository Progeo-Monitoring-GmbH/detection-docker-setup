import { describe, expect, it } from 'vitest';
import { dialForLanguage, formatPhone, isPhoneSavable, isValidE164, parsePhone, toE164 } from './phone';

describe('dialForLanguage', () => {
  it('starts the phone fields of an English location with US +1, the others with +49', () => {
    expect(dialForLanguage('en')).toBe('1');
    expect(dialForLanguage('en-GB')).toBe('1');
    expect(dialForLanguage('de')).toBe('49');
    // Unset: German.
    expect(dialForLanguage('')).toBe('49');
    expect(dialForLanguage(null)).toBe('49');
    expect(parsePhone('', dialForLanguage('en'))).toEqual({ dial: '1', national: '' });
  });
});

describe('parsePhone', () => {
  it('splits E.164 into calling code and national number', () => {
    expect(parsePhone('+4917112345678')).toEqual({ dial: '49', national: '17112345678' });
    expect(parsePhone('+43 664 1234567')).toEqual({ dial: '43', national: '6641234567' });
    expect(parsePhone('+420601234567')).toEqual({ dial: '420', national: '601234567' });
    expect(parsePhone('+12025550123')).toEqual({ dial: '1', national: '2025550123' });
  });

  it('understands 00 prefixes and legacy national numbers', () => {
    expect(parsePhone('0041 79 123 45 67')).toEqual({ dial: '41', national: '791234567' });
    expect(parsePhone('0171 / 123-4567')).toEqual({ dial: '49', national: '1711234567' });
    expect(parsePhone('06 12345678', '39')).toEqual({ dial: '39', national: '0612345678' });
  });

  it('keeps calling codes outside the list', () => {
    expect(parsePhone('+81312345678')).toEqual({ dial: '81', national: '312345678' });
    expect(parsePhone('+380441234567')).toEqual({ dial: '380', national: '441234567' });
  });

  it('defaults an empty value to the default calling code', () => {
    expect(parsePhone('')).toEqual({ dial: '49', national: '' });
    expect(parsePhone(null, '43')).toEqual({ dial: '43', national: '' });
  });
});

describe('toE164', () => {
  it('drops the trunk 0 and separators', () => {
    expect(toE164('49', '0171 123 45-67')).toBe('+491711234567');
    expect(toE164('43', '(0664) 1234567')).toBe('+436641234567');
  });

  it('keeps the leading 0 of Italian numbers', () => {
    expect(toE164('39', '06 12345678')).toBe('+390612345678');
  });

  it('lets a full international number in the number field win', () => {
    expect(toE164('49', '+43 664 1234567')).toBe('+436641234567');
    expect(toE164('49', '0041791234567')).toBe('+41791234567');
  });

  it('is empty without digits', () => {
    expect(toE164('49', '')).toBe('');
    expect(toE164('49', ' - ')).toBe('');
  });

  it('round-trips with parsePhone', () => {
    const { dial, national } = parsePhone('+4917112345678');
    expect(toE164(dial, national)).toBe('+4917112345678');
  });
});

describe('validation', () => {
  it('accepts 7 to 15 digits after the plus', () => {
    expect(isValidE164('+4917112345678')).toBe(true);
    expect(isValidE164('+491234')).toBe(false);
    expect(isValidE164('+4912345678901234')).toBe(false);
    expect(isValidE164('017112345678')).toBe(false);
    expect(isValidE164('+0171123456')).toBe(false);
  });

  it('allows saving an empty field', () => {
    expect(isPhoneSavable('')).toBe(true);
    expect(isPhoneSavable('+491')).toBe(false);
  });

  it('formats valid numbers and leaves the rest alone', () => {
    expect(formatPhone('+4917112345678')).toBe('+49 17112345678');
    expect(formatPhone('0171 12345')).toBe('0171 12345');
  });
});
