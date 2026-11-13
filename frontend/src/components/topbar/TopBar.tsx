import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Archive, DoorOpen, Eye, InfoCircle, PersonGear } from 'react-bootstrap-icons';
import { useAuth } from '../../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../../axiosConfig';
import { UserProfileModal } from '../../main/UserProfile.tsx';
import { PRIVACY_POLICY_URL } from '../privacy/consent';
import { useConsent } from '../privacy/ConsentProvider';
import { isDemoUser } from '../../main/demo';
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

  const [username, setUsername] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  // Staff only: archived measurements hidden in every view (null: not staff /
  // not loaded) - stored on the server (ProgeoMeasurement.shows_archived).
  const [hideArchived, setHideArchived] = useState<boolean | null>(null);
  const [archivedBusy, setArchivedBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      '/v1/user/profile/',
      (response) => {
        setUsername(response?.data?.username || '');
        const hide = response?.data?.hide_archived_measurements;
        setHideArchived(typeof hide === 'boolean' ? hide : null);
      },
      () => {},
    );
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

  const initials = username.slice(0, 2).toUpperCase() || '?';
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
          title={auth.viewAsUser ? undefined : t('topbar_view_as_user_title')}
          className={auth.viewAsUser ? 'topbar-pill topbar-pill--accent' : 'topbar-pill'}
          data-testid="topbar-view-as-user"
        >
          {auth.viewAsUser ? <PersonGear size={16} /> : <Eye size={16} />}
          {auth.viewAsUser
            ? t('topbar_view_as_staff')
            : t('topbar_view_as_user')}
        </button>
      )}
      {auth.canViewAsUser && !auth.viewAsUser && hideArchived !== null && (
        <button
          type="button"
          onClick={toggleArchived}
          disabled={archivedBusy}
          aria-pressed={!hideArchived}
          title={t('topbar_archived_title')}
          className={hideArchived ? 'topbar-pill topbar-pill--muted' : 'topbar-pill'}
          data-testid="topbar-archived-toggle"
        >
          <Archive size={16} />
          {hideArchived ? t('topbar_archived_hidden') : t('topbar_archived_shown')}
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
              <Link
                to={PRIVACY_POLICY_URL}
                onClick={() => setInfoOpen(false)}
                className="topbar-info-link"
                data-testid="topbar-privacy-link"
              >
                {t('consent_privacy_policy')}
              </Link>
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
        className="topbar-account"
        data-testid="topbar-account"
      >
        <span className="topbar-avatar">
          {initials}
        </span>
        <span className="topbar-username" data-testid="topbar-username">
          {username}
        </span>
      </button>

      <button
        type="button"
        onClick={() => auth.logoutAction()}
        title={t('topbar_logout')}
        aria-label={t('topbar_logout')}
        className="topbar-pill topbar-pill--icon"
        data-testid="topbar-logout"
      >
        <DoorOpen size={16} />
      </button>

      <UserProfileModal
        show={profileOpen}
        onHide={() => setProfileOpen(false)}
      />
    </div>
  );
};

export default TopBar;
