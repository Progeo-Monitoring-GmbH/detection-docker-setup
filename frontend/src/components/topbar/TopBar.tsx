import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DoorOpen, InfoCircle } from 'react-bootstrap-icons';
import { useAuth } from '../../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../../axiosConfig';
import { useProgeoRole, type ProgeoRole } from '../../main/roleModel';
import { UserProfileModal } from '../../main/UserProfile.tsx';

const ROLE_LABEL_KEY: Record<ProgeoRole, string> = {
  nutzer: 'topbar_role_nutzer',
  kundenadmin: 'topbar_role_kundenadmin',
  'progeo-admin': 'topbar_role_progeo_admin',
};

const LANGUAGES: { code: 'de' | 'en'; label: string }[] = [
  { code: 'de', label: 'DE' },
  { code: 'en', label: 'EN' },
];

const TopBar = () => {
  const auth = useAuth();
  const { t, i18n } = useTranslation();
  const role = useProgeoRole();

  const [username, setUsername] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      '/v1/user/profile/',
      (response) => setUsername(response?.data?.username || ''),
      () => {},
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const currentLang =
    (i18n.language || 'de').slice(0, 2).toLowerCase() === 'en' ? 'en' : 'de';

  const pillButtonStyle = (active = false) => ({
    height: 40,
    padding: active ? '0 14px' : 0,
    width: active ? undefined : 40,
    border: 'none',
    borderRadius: 'var(--progeo-radius-pill)',
    background: 'var(--progeo-surface)',
    boxShadow: 'var(--progeo-shadow-chrome)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--progeo-blue)',
  });

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '.03em',
          textTransform: 'uppercase',
          color: 'var(--progeo-blue)',
          background: 'var(--progeo-track)',
          borderRadius: 'var(--progeo-radius-pill)',
          padding: '6px 12px',
        }}
      >
        {t(ROLE_LABEL_KEY[role])}
      </span>

      <div style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => {
            setInfoOpen((open) => !open);
            setLangOpen(false);
          }}
          title={t('topbar_info_title')}
          style={pillButtonStyle(false)}
        >
          <InfoCircle size={16} />
        </button>
        {infoOpen && (
          <div
            style={{
              position: 'absolute',
              top: 48,
              right: 0,
              width: 240,
              background: 'var(--progeo-surface)',
              borderRadius: 14,
              boxShadow: '0 14px 40px rgba(11, 54, 89, .2)',
              padding: 14,
              zIndex: 50,
              fontSize: 12.5,
              color: 'var(--progeo-blue)',
              lineHeight: 1.5,
            }}
          >
            {t('topbar_info_company')}
          </div>
        )}
      </div>

      <div style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => {
            setLangOpen((open) => !open);
            setInfoOpen(false);
          }}
          style={pillButtonStyle(true)}
        >
          {currentLang.toUpperCase()}
        </button>
        {langOpen && (
          <div
            style={{
              position: 'absolute',
              top: 48,
              right: 0,
              width: 140,
              background: 'var(--progeo-surface)',
              borderRadius: 14,
              boxShadow: '0 14px 40px rgba(11, 54, 89, .2)',
              padding: 8,
              zIndex: 50,
            }}
          >
            {LANGUAGES.map((language) => (
              <button
                key={language.code}
                type="button"
                onClick={() => {
                  void i18n.changeLanguage(language.code);
                  setLangOpen(false);
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  background:
                    currentLang === language.code
                      ? 'var(--progeo-track-soft)'
                      : 'none',
                  border: 'none',
                  padding: '9px 10px',
                  borderRadius: 9,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  color: 'var(--progeo-blue)',
                }}
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
        style={{
          height: 40,
          padding: '4px 16px 4px 5px',
          border: 'none',
          borderRadius: 'var(--progeo-radius-pill)',
          background: 'var(--progeo-surface)',
          boxShadow: 'var(--progeo-shadow-chrome)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          cursor: 'pointer',
          fontFamily: 'inherit',
          color: 'var(--progeo-blue)',
        }}
      >
        <span
          style={{
            width: 31,
            height: 31,
            borderRadius: '50%',
            background: '#1E5688',
            color: '#fff',
            fontSize: 11.5,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {initials}
        </span>
        <span style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>
          {username}
        </span>
      </button>

      <button
        type="button"
        onClick={() => auth.logoutAction()}
        title={t('topbar_logout')}
        style={pillButtonStyle(false)}
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
