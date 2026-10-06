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
import {
  CONTROLLER,
  PRIVACY_POLICY_LAST_UPDATED,
  buildPolicySections,
} from './privacyPolicyContent';
import './PrivacyPolicyPage.css';

const HIGHLIGHTS = [
  {
    icon: <EyeSlash size={18} />,
    title: 'Kein Tracking',
    text: 'Keine Analyse-, Werbe- oder Tracking-Cookies.',
  },
  {
    icon: <GeoAlt size={18} />,
    title: 'Karten nur mit Einwilligung',
    text: 'Externe Kartendienste laden erst nach Ihrer Zustimmung.',
  },
  {
    icon: <Bell size={18} />,
    title: 'Benachrichtigungen',
    text: 'E-Mail und SMS nur für Alarme und Meldungen zu Ihren Objekten.',
  },
  {
    icon: <PersonCheck size={18} />,
    title: 'Ihre Rechte',
    text: 'Auskunft, Berichtigung, Löschung und Widerspruch – jederzeit.',
  },
];

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

  const sections = useMemo(
    () =>
      buildPolicySections({
        consentButton: (
          <button
            type="button"
            className="privacy-inline-button"
            onClick={openSettings}
          >
            <Sliders size={14} />
            Datenschutz-Einstellungen öffnen
          </button>
        ),
      }),
    [openSettings],
  );
  const sectionIds = useMemo(
    () => sections.map((section) => section.id),
    [sections],
  );
  const activeId = useActiveSection(sectionIds);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `Datenschutzerklärung – ProGeo`;
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <div className="privacy-page" lang="de">
      <div className="privacy-shell">
        <Link to="/" className="privacy-back">
          <ArrowLeft size={14} />
          {t('privacy_back_to_app')}
        </Link>

        {!i18n.language?.startsWith('de') && (
          <div className="privacy-language-note" lang={i18n.language}>
            {t('privacy_german_only')}
          </div>
        )}

        <header className="privacy-hero">
          <span className="privacy-hero-eyebrow">
            <ShieldLock size={14} />
            Datenschutz
          </span>
          <h1>Datenschutzerklärung</h1>
          <p>
            Transparent und verständlich: Hier erfahren Sie, welche
            personenbezogenen Daten wir im ProGeo-Monitoring-Portal verarbeiten,
            wofür wir sie nutzen und welche Rechte Sie haben.
          </p>
          <div className="privacy-hero-meta">
            <span className="privacy-chip">
              <Calendar3 size={13} />
              Stand: {PRIVACY_POLICY_LAST_UPDATED}
            </span>
            <button
              type="button"
              className="privacy-hero-button"
              onClick={openSettings}
            >
              <Sliders size={14} />
              Datenschutz-Einstellungen
            </button>
            <button
              type="button"
              className="privacy-hero-button ghost"
              onClick={() => window.print()}
            >
              <Printer size={14} />
              Drucken
            </button>
          </div>
        </header>

        <div className="privacy-highlights">
          {HIGHLIGHTS.map((highlight) => (
            <div key={highlight.title} className="privacy-highlight">
              <span className="privacy-highlight-icon">{highlight.icon}</span>
              <strong>{highlight.title}</strong>
              <span>{highlight.text}</span>
            </div>
          ))}
        </div>

        <div className="privacy-layout">
          <nav className="privacy-toc" aria-label="Inhaltsverzeichnis">
            <div className="privacy-toc-title">Inhalt</div>
            <ol>
              {sections.map((section) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className={section.id === activeId ? 'active' : undefined}
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

          <main className="privacy-content">
            {sections.map((section) => (
              <section
                key={section.id}
                id={section.id}
                className="privacy-section"
                aria-labelledby={`${section.id}-title`}
              >
                <h2 id={`${section.id}-title`}>{section.title}</h2>
                {section.body}
              </section>
            ))}
          </main>
        </div>

        <footer className="privacy-footer">
          © {new Date().getFullYear()} {CONTROLLER.name}
        </footer>
      </div>
    </div>
  );
};

export default PrivacyPolicyPage;
