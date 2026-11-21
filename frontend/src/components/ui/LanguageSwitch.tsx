import { useTranslation } from 'react-i18next';
import { repeatedTestId } from '../../testIds';
import './LanguageSwitch.css';

const LANGUAGES = [
  { code: 'de', label: 'DE', name: 'Deutsch' },
  { code: 'en', label: 'EN', name: 'English' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

/** sessionStorage key: the language was chosen explicitly on a public page
 * (login, ...) - TopBar stores it in the profile after the sign-in. */
export const CHOSEN_LANGUAGE_KEY = 'progeo.languageChosen';

export const currentLanguage = (language: string | undefined): LanguageCode =>
  (language || 'de').slice(0, 2).toLowerCase() === 'en' ? 'en' : 'de';

/** The explicitly chosen language of a public page, or null (and forgets it). */
export const takeChosenLanguage = (): LanguageCode | null => {
  try {
    const chosen = window.sessionStorage.getItem(CHOSEN_LANGUAGE_KEY);
    window.sessionStorage.removeItem(CHOSEN_LANGUAGE_KEY);
    return chosen === 'de' || chosen === 'en' ? chosen : null;
  } catch {
    return null;
  }
};

/**
 * DE | EN switch of the public pages (login, access request, privacy
 * policy). The chosen language is the language of the mails these pages
 * trigger (they send it along), and it is remembered for the profile once
 * the user signs in.
 */
const LanguageSwitch = ({ testId = 'language-switch' }: { testId?: string }) => {
  const { i18n } = useTranslation();
  const active = currentLanguage(i18n.language);

  const choose = (code: LanguageCode) => {
    void i18n.changeLanguage(code);
    try {
      window.sessionStorage.setItem(CHOSEN_LANGUAGE_KEY, code);
    } catch {
      // Storage unavailable: the choice still applies to this page.
    }
  };

  return (
    <div className="language-switch" role="group" aria-label="Sprache / Language" data-testid={testId}>
      {LANGUAGES.map((language) => (
        <button
          key={language.code}
          type="button"
          lang={language.code}
          title={language.name}
          aria-pressed={active === language.code}
          className={active === language.code ? 'language-switch-option is-active' : 'language-switch-option'}
          onClick={() => choose(language.code)}
          {...repeatedTestId(`${testId}-option`, language.code)}
        >
          {language.label}
        </button>
      ))}
    </div>
  );
};

export default LanguageSwitch;
