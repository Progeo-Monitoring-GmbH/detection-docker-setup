import Cookies from 'js-cookie';

// In-app route (public, no login required) - see main/PrivacyPolicyPage.tsx.
export const PRIVACY_POLICY_URL = '/datenschutz';

export const CONSENT_STORAGE_KEY = 'progeo_consent';

// Bump whenever the categories or their description change materially - every
// stored decision with an older version is discarded and the banner asks again.
export const CONSENT_VERSION = 1;

// Re-ask after 12 months, as recommended by most EU data protection authorities.
export const CONSENT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

// Cookie written by the previous react-cookie-consent based banner. It only
// recorded an unspecific "accepted", which is not valid for the new categories.
const LEGACY_CONSENT_COOKIE = 'progeo_cookie_consent';

export type ConsentCategories = {
  necessary: true;
  externalMaps: boolean;
};

export type OptionalConsentCategory = Exclude<
  keyof ConsentCategories,
  'necessary'
>;

export type ConsentChoices = Pick<ConsentCategories, OptionalConsentCategory>;

export type ConsentRecord = {
  version: number;
  decidedAt: string;
  categories: ConsentCategories;
};

const isValidRecord = (value: unknown, now: number): value is ConsentRecord => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<ConsentRecord>;
  if (
    record.version !== CONSENT_VERSION ||
    typeof record.decidedAt !== 'string'
  ) {
    return false;
  }
  const decidedAt = Date.parse(record.decidedAt);
  if (!Number.isFinite(decidedAt) || now - decidedAt > CONSENT_MAX_AGE_MS) {
    return false;
  }
  return typeof record.categories?.externalMaps === 'boolean';
};

/** The stored decision, or null when the user has not (validly) decided yet. */
export const readConsent = (now: number = Date.now()): ConsentRecord | null => {
  try {
    const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return isValidRecord(parsed, now) ? parsed : null;
  } catch {
    return null;
  }
};

export const writeConsent = (
  choices: ConsentChoices,
  now: Date = new Date(),
): ConsentRecord => {
  const record: ConsentRecord = {
    version: CONSENT_VERSION,
    decidedAt: now.toISOString(),
    categories: { necessary: true, externalMaps: choices.externalMaps },
  };
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage blocked (private mode etc.) - the choice still applies for this page load.
  }
  return record;
};

export const removeLegacyConsentCookie = () => {
  Cookies.remove(LEGACY_CONSENT_COOKIE);
};
