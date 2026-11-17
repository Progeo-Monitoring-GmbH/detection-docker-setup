import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, DoorOpen, Eye, InfoCircle, PersonGear } from 'react-bootstrap-icons';
import { useAuth } from '../../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../../axiosConfig';
import { UserProfileModal, displayName } from '../../main/UserProfile.tsx';
import ConfirmDialog from '../ui/kit/ConfirmDialog';
import { PRIVACY_POLICY_URL } from '../privacy/consent';
import { useConsent } from '../privacy/ConsentProvider';
import { isDemoUser } from '../../main/demo';
import { takeChosenLanguage } from '../ui/LanguageSwitch';
import useDemoHeartbeat from '../../main/useDemoHeartbeat';
import { repeatedTestId } from '../../testIds';
import './TopBar.css';

const LANGUAGES: { code: 'de' | 'en'; label: string }[] = [
  { code: 'de', label: 'DE' },
  { code: 'en', label: 'EN' },
];

const TopBar = () => {
  const auth = useAuth();
  const { t, i18n } = useTranslation();
  const { openSettings } = useConsent();

  // The top bar is on every portal page - it carries the demo's activity
  // heartbeat (a no-op for everyone else).
  useDemoHeartbeat();

  const [name, setName] = useState('');
  const [initials, setInitials] = useState('');
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  // Staff only: archived measurements hidden in every view (null: not staff /
  // not loaded) - stored on the server (ProgeoMeasurement.shows_archived).
  const [hideArchived, setHideArchived] = useState<boolean | null>(null);
  const [archivedBusy, setArchivedBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // The profile language is applied once per page load - unless a language
  // was just chosen on the login page (that one wins and is saved).
  const languageSynced = useRef(false);

  // Again after Mein Konto closed: the name may have changed there.
  const loadProfile = () => {
    void axiosConfig.perform_get(
      auth,
      '/v1/user/profile/',
      (response) => {
        const data = response?.data || {};
        // First and last name - the login name only when both are empty.
        setName(displayName(data));
        const parts = [data.first_name, data.last_name].map((part) => String(part || '').trim()).filter(Boolean);
        setInitials(
          (parts.length ? parts.map((part) => part[0]).join('') : String(data.username || '').slice(0, 2)).toUpperCase(),
        );
        const hide = response?.data?.hide_archived_measurements;
        setHideArchived(typeof hide === 'boolean' ? hide : null);
        // Another device or browser: the portal follows the language saved in
        // the profile (the one of the mails and messenger messages, too).
        if (!languageSynced.current) {
          languageSynced.current = true;
          const saved = data.language_saved ? String(data.language || '') : '';
          if ((saved === 'de' || saved === 'en') && !(i18n.language || '').startsWith(saved)) {
            void i18n.changeLanguage(saved);
          }
        }
      },
      () => {},
    );
  };

  useEffect(() => {
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The views load their measurements once - a reload shows them with or without the archived ones.
  const toggleArchived = () => {
    if (hideArchived === null || archivedBusy) {
      return;
    }
    setArchivedBusy(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/user/archived_measurements/',
      { hide: !hideArchived },
      () => window.location.reload(),
      () => setArchivedBusy(false),
    );
  };

  useEffect(() => {
    const onClickAway = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setInfoOpen(false);
        setLangOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, []);

  // A language chosen on the login page becomes the profile language (mails,
  // messenger) once signed in - once, then the top bar's switch takes over.
  useEffect(() => {
    if (!auth.user || isDemoUser(auth.user)) {
      return;
    }
    const chosen = takeChosenLanguage();
    if (chosen) {
      languageSynced.current = true;
      void axiosConfig.perform_post(auth, '/v1/user/language/', { language: chosen }, () => {}, () => {});
    }
  }, [auth]);

  const demo = isDemoUser(auth.user);
  const currentLang =
    (i18n.language || 'de').slice(0, 2).toLowerCase() === 'en' ? 'en' : 'de';

  return (
    <div
      ref={containerRef}
      className="topbar"
      data-testid="topbar"
    >
      {demo && (
        <span
          title={t('demo_subtitle')}
          className="topbar-demo-badge"
          data-testid="topbar-demo-badge"
        >
          {t('demo_badge')}
        </span>
      )}
      {auth.canViewAsUser && (
        <button
          type="button"
          onClick={() => auth.setViewAsUser(!auth.viewAsUser)}
          title={auth.viewAsUser ? t('topbar_view_as_staff') : t('topbar_view_as_user_title')}
          aria-label={auth.viewAsUser ? t('topbar_view_as_staff') : t('topbar_view_as_user')}
          className={auth.viewAsUser ? 'topbar-pill topbar-pill--accent' : 'topbar-pill'}
          data-testid="topbar-view-as-user"
        >
          {auth.viewAsUser ? <PersonGear size={16} /> : <Eye size={16} />}
          <span className="topbar-pill-label">
            {auth.viewAsUser
              ? t('topbar_view_as_staff')
              : t('topbar_view_as_user')}
          </span>
        </button>
      )}
      {auth.canViewAsUser && !auth.viewAsUser && hideArchived !== null && (
        <button
          type="button"
          onClick={toggleArchived}
          disabled={archivedBusy}
          aria-pressed={!hideArchived}
          title={t('topbar_archived_title')}
          aria-label={hideArchived ? t('topbar_archived_hidden') : t('topbar_archived_shown')}
          className={hideArchived ? 'topbar-pill topbar-pill--muted' : 'topbar-pill'}
          data-testid="topbar-archived-toggle"
        >
          <Archive size={16} />
          <span className="topbar-pill-label">
            {hideArchived ? t('topbar_archived_hidden') : t('topbar_archived_shown')}
          </span>
        </button>
      )}
      <div className="topbar-anchor">
        <button
          type="button"
          onClick={() => {
            setInfoOpen((open) => !open);
            setLangOpen(false);
          }}
          title={t('topbar_info_title')}
          aria-label={t('topbar_info_title')}
          className="topbar-pill topbar-pill--icon"
          data-testid="topbar-info"
        >
          <InfoCircle size={16} />
        </button>
        {infoOpen && (
          <div className="topbar-popover topbar-popover--info" data-testid="topbar-info-popover">
            {t('topbar_info_company')}
            <div className="topbar-info-links">
              <a
                href={PRIVACY_POLICY_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setInfoOpen(false)}
                className="topbar-info-link"
                data-testid="topbar-privacy-link"
              >
                {t('consent_privacy_policy')}
              </a>
              <button
                type="button"
                onClick={() => {
                  setInfoOpen(false);
                  openSettings();
                }}
                className="topbar-text-button"
                data-testid="topbar-privacy-settings"
              >
                {t('consent_open_settings')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="topbar-anchor">
        <button
          type="button"
          onClick={() => {
            setLangOpen((open) => !open);
            setInfoOpen(false);
          }}
          className="topbar-pill"
          data-testid="topbar-language"
        >
          {currentLang.toUpperCase()}
        </button>
        {langOpen && (
          <div className="topbar-popover topbar-popover--lang" data-testid="topbar-language-menu">
            {LANGUAGES.map((language) => (
              <button
                key={language.code}
                type="button"
                onClick={() => {
                  void i18n.changeLanguage(language.code);
                  setLangOpen(false);
                  // Also the language of the user's mails and messenger
                  // messages (UserProfile.language) - not for the read-only demo.
                  if (auth.user && !demo) {
                    void axiosConfig.perform_post(auth, '/v1/user/language/', { language: language.code }, () => {}, () => {});
                  }
                }}
                className={
                  currentLang === language.code
                    ? 'topbar-lang-item topbar-lang-item--active'
                    : 'topbar-lang-item'
                }
                {...repeatedTestId('topbar-language-option', language.code)}
              >
                {language.code === 'de' ? 'Deutsch' : 'English'}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setProfileOpen(true)}
        title={t('topbar_account_title')}
        aria-label={`${t('topbar_account_title')}: ${name}`}
        className="topbar-account"
        data-testid="topbar-account"
      >
        <span className="topbar-avatar">
          {initials || '?'}
        </span>
        <span className="topbar-username" data-testid="topbar-username">
          {name}
        </span>
      </button>

      <button
        type="button"
        onClick={() => setLogoutOpen(true)}
        title={t('topbar_logout')}
        aria-label={t('topbar_logout')}
        className="topbar-pill topbar-pill--icon"
        data-testid="topbar-logout"
      >
        <DoorOpen size={16} />
      </button>

      <UserProfileModal
        show={profileOpen}
        onHide={() => {
          setProfileOpen(false);
          loadProfile();
        }}
      />

      {/* Against misclicks (trade fair screens): logging out asks first. */}
      <ConfirmDialog
        testId="topbar-logout-dialog"
        show={logoutOpen}
        danger={false}
        title={t('topbar_logout_confirm_title')}
        message={t('topbar_logout_confirm_text')}
        confirmLabel={t('topbar_logout')}
        cancelLabel={t('tfa_cancel')}
        onCancel={() => setLogoutOpen(false)}
        onConfirm={() => {
          setLogoutOpen(false);
          auth.logoutAction();
        }}
      />
    </div>
  );
};

export default TopBar;
