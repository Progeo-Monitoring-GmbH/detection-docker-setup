import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import {
  ArrowLeft,
  Bell,
  Calendar3,
  EyeSlash,
  GeoAlt,
  PersonCheck,
  Printer,
  ShieldLock,
  Sliders,
} from 'react-bootstrap-icons';
import { useConsent } from '../components/privacy/ConsentProvider';
import LanguageSwitch, { currentLanguage, type LanguageCode } from '../components/ui/LanguageSwitch';
import {
  CONTROLLER,
  PRIVACY_POLICY_LAST_UPDATED,
  buildPolicySections,
} from './privacyPolicyContent';
import { buildPolicySectionsEn } from './privacyPolicyContentEn';
import { repeatedTestId } from '../testIds';
import './PrivacyPolicyPage.css';

/** The page's own texts per language (the sections: privacyPolicyContent[En].tsx). */
const PAGE_TEXT = {
  de: {
    documentTitle: 'Datenschutzerklärung – ProGeo',
    eyebrow: 'Datenschutz',
    title: 'Datenschutzerklärung',
    intro:
      'Transparent und verständlich: Hier erfahren Sie, welche personenbezogenen Daten wir im ProGeo-Monitoring-Portal verarbeiten, wofür wir sie nutzen und welche Rechte Sie haben.',
    updated: 'Stand',
    settings: 'Datenschutz-Einstellungen',
    openSettings: 'Datenschutz-Einstellungen öffnen',
    print: 'Drucken',
    contents: 'Inhalt',
    contentsLabel: 'Inhaltsverzeichnis',
    translationNote: null as string | null,
    showGerman: '',
    highlights: [
      { icon: <EyeSlash size={18} />, title: 'Statistik nur mit Einwilligung', text: 'Keine Werbe- oder Tracking-Cookies; Nutzungsstatistik erst nach Ihrer Zustimmung.' },
      { icon: <GeoAlt size={18} />, title: 'Karten nur mit Einwilligung', text: 'Externe Kartendienste laden erst nach Ihrer Zustimmung.' },
      { icon: <Bell size={18} />, title: 'Benachrichtigungen', text: 'E-Mail, SMS und Messenger nur für Alarme und Meldungen zu Ihren Objekten – jederzeit abbestellbar.' },
      { icon: <PersonCheck size={18} />, title: 'Ihre Rechte', text: 'Auskunft, Berichtigung, Löschung und Widerspruch – jederzeit.' },
    ],
  },
  en: {
    documentTitle: 'Privacy policy – ProGeo',
    eyebrow: 'Data protection',
    title: 'Privacy policy',
    intro:
      'Transparent and easy to understand: here you can find out which personal data we process in the ProGeo monitoring portal, what we use it for and what rights you have.',
    updated: 'Last updated',
    settings: 'Privacy settings',
    openSettings: 'Open privacy settings',
    print: 'Print',
    contents: 'Contents',
    contentsLabel: 'Table of contents',
    translationNote:
      'This English version is a translation for your convenience. Only the German version is legally binding.' as string | null,
    showGerman: 'Show the German version',
    highlights: [
      { icon: <EyeSlash size={18} />, title: 'Statistics only with consent', text: 'No advertising or tracking cookies; usage statistics only after your consent.' },
      { icon: <GeoAlt size={18} />, title: 'Maps only with consent', text: 'External map services load only after your consent.' },
      { icon: <Bell size={18} />, title: 'Notifications', text: 'E-mail, SMS and messenger only for alarms and messages about your objects - you can unsubscribe at any time.' },
      { icon: <PersonCheck size={18} />, title: 'Your rights', text: 'Access, rectification, erasure and objection - at any time.' },
    ],
  },
} satisfies Record<LanguageCode, unknown>;

/** Highlights the TOC entry of the section currently in view. */
const useActiveSection = (ids: string[]) => {
  const [activeId, setActiveId] = useState(ids[0]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      // A section counts as active while it crosses the upper third of the viewport.
      { rootMargin: '0px 0px -66% 0px' },
    );
    ids.forEach((id) => {
      const element = document.getElementById(id);
      if (element) {
        observer.observe(element);
      }
    });
    return () => observer.disconnect();
  }, [ids]);

  return activeId;
};

/**
 * Public privacy policy (route /datenschutz) - reachable without login, e.g.
 * from the login page and the cookie banner.
 */
const PrivacyPolicyPage = () => {
  const { t, i18n } = useTranslation();
  const { openSettings } = useConsent();
  const language = currentLanguage(i18n.language);
  const text = PAGE_TEXT[language];

  const sections = useMemo(() => {
    const options = {
      consentButton: (
        <button
          type="button"
          className="privacy-inline-button"
          onClick={openSettings}
          data-testid="privacy-policy-inline-settings"
        >
          <Sliders size={14} />
          {PAGE_TEXT[language].openSettings}
        </button>
      ),
    };
    return language === 'en' ? buildPolicySectionsEn(options) : buildPolicySections(options);
  }, [language, openSettings]);
  const sectionIds = useMemo(
    () => sections.map((section) => section.id),
    [sections],
  );
  const activeId = useActiveSection(sectionIds);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = PAGE_TEXT[language].documentTitle;
    return () => {
      document.title = previousTitle;
    };
  }, [language]);

  return (
    <div className="privacy-page" lang={language} data-testid="page-privacy-policy">
      <div className="privacy-shell">
        <div className="privacy-topline">
          <Link to="/" className="privacy-back" data-testid="privacy-policy-back">
            <ArrowLeft size={14} />
            {t('privacy_back_to_app')}
          </Link>
          <LanguageSwitch testId="privacy-policy-language" />
        </div>

        {text.translationNote && (
          <div className="privacy-language-note" data-testid="privacy-policy-language-note">
            {text.translationNote}{' '}
            <button
              type="button"
              className="privacy-inline-link"
              onClick={() => void i18n.changeLanguage('de')}
              data-testid="privacy-policy-show-german"
            >
              {text.showGerman}
            </button>
          </div>
        )}

        <header className="privacy-hero" data-testid="privacy-policy-hero">
          <span className="privacy-hero-eyebrow">
            <ShieldLock size={14} />
            {text.eyebrow}
          </span>
          <h1>{text.title}</h1>
          <p>{text.intro}</p>
          <div className="privacy-hero-meta">
            <span className="privacy-chip" data-testid="privacy-policy-last-updated">
              <Calendar3 size={13} />
              {text.updated}: {PRIVACY_POLICY_LAST_UPDATED}
            </span>
            <button
              type="button"
              className="privacy-hero-button"
              onClick={openSettings}
              data-testid="privacy-policy-settings"
            >
              <Sliders size={14} />
              {text.settings}
            </button>
            <button
              type="button"
              className="privacy-hero-button ghost"
              onClick={() => window.print()}
              data-testid="privacy-policy-print"
            >
              <Printer size={14} />
              {text.print}
            </button>
          </div>
        </header>

        <div className="privacy-highlights" data-testid="privacy-policy-highlights">
          {text.highlights.map((highlight) => (
            <div key={highlight.title} className="privacy-highlight" {...repeatedTestId('privacy-policy-highlight', highlight.title)}>
              <span className="privacy-highlight-icon">{highlight.icon}</span>
              <strong>{highlight.title}</strong>
              <span>{highlight.text}</span>
            </div>
          ))}
        </div>

        <div className="privacy-layout">
          <nav className="privacy-toc" aria-label={text.contentsLabel} data-testid="privacy-policy-toc">
            <div className="privacy-toc-title">{text.contents}</div>
            <ol>
              {sections.map((section) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className={section.id === activeId ? 'active' : undefined}
                    {...repeatedTestId('privacy-policy-toc-link', section.id)}
                    aria-current={
                      section.id === activeId ? 'location' : undefined
                    }
                  >
                    {section.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <main className="privacy-content" data-testid="privacy-policy-content">
            {sections.map((section) => (
              <section
                key={section.id}
                id={section.id}
                className="privacy-section"
                aria-labelledby={`${section.id}-title`}
                {...repeatedTestId('privacy-policy-section', section.id)}
              >
                <h2 id={`${section.id}-title`}>{section.title}</h2>
                {section.body}
              </section>
            ))}
          </main>
        </div>

        <footer className="privacy-footer" data-testid="privacy-policy-footer">
          © {new Date().getFullYear()} {CONTROLLER.name}
        </footer>
      </div>
    </div>
  );
};

export default PrivacyPolicyPage;
