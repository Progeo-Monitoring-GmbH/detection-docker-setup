import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  CONSENT_STORAGE_KEY,
  readConsent,
  removeLegacyConsentCookie,
  writeConsent,
  type ConsentChoices,
  type ConsentRecord,
  type OptionalConsentCategory,
} from './consent';

type ConsentContextValue = {
  /** null until the user has made a (still valid) decision. */
  consent: ConsentRecord | null;
  allows: (category: OptionalConsentCategory) => boolean;
  save: (choices: ConsentChoices) => void;
  acceptAll: () => void;
  rejectAll: () => void;
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
};

const ConsentContext = createContext<ConsentContextValue | null>(null);

/**
 * Holds the user's privacy decision. Optional features (currently only the
 * external map tiles) must check `allows(...)` before contacting third parties.
 */
export const ConsentProvider = ({ children }: { children: ReactNode }) => {
  const [consent, setConsent] = useState<ConsentRecord | null>(() =>
    readConsent(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    removeLegacyConsentCookie();

    // Keep other open tabs in sync, e.g. after revoking consent in one of them.
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === CONSENT_STORAGE_KEY) {
        setConsent(readConsent());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const save = useCallback((choices: ConsentChoices) => {
    setConsent(writeConsent(choices));
    setSettingsOpen(false);
  }, []);

  const value = useMemo<ConsentContextValue>(
    () => ({
      consent,
      allows: (category) => consent?.categories[category] === true,
      save,
      acceptAll: () => save({ externalMaps: true }),
      rejectAll: () => save({ externalMaps: false }),
      settingsOpen,
      openSettings: () => setSettingsOpen(true),
      closeSettings: () => setSettingsOpen(false),
    }),
    [consent, save, settingsOpen],
  );

  return (
    <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>
  );
};

export const useConsent = (): ConsentContextValue => {
  const context = useContext(ConsentContext);
  if (!context) {
    throw new Error('useConsent must be used inside <ConsentProvider>');
  }
  return context;
};
