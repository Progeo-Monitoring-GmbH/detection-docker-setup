import React from 'react';
import { Container } from 'react-bootstrap';
import { BrowserRouter, useLocation } from 'react-router';
import { SnackbarProvider } from 'notistack';
import { useTranslation } from 'react-i18next';
import CoreAuthProvider from '../hooks/CoreAuthProvider';
import { ModalProvider } from './components/modal/coreModalContext';
import CookieBanner from './components/privacy/CookieBanner';
import Toast from './components/ui/Toast';
import MaintenanceGate from './components/ui/MaintenanceScreen';
import { ConsentProvider, useConsent } from './components/privacy/ConsentProvider';

import CoreRoutes from './CoreRoutes';
import { ActivityTracking } from './activity/useActivityTracking';

import './i18n';
import './App.css';

/**
 * True when this frontend runs against the staging server: either built with
 * VITE_SERVER_ENV=staging (docker/frontend/.env.production + Dockerfile build
 * arg) or opened through a host name that contains "staging".
 *
 * Production builds default to VITE_SERVER_ENV=production, so the staging
 * overlay below stays off and the production UI is unchanged.
 */
const isStagingServer = (): boolean =>
  import.meta.env.VITE_SERVER_ENV === 'staging' ||
  (typeof window !== 'undefined' &&
    window.location.hostname.toLowerCase().includes('staging'));

const STAGING_BANNER_TEXT =
  "Staging Server - It's okay to press any button! Try to break it!";

/**
 * Fixed pink frame around the viewport plus the always-visible top-left
 * banner. Both ignore pointer events, so every button stays clickable - on
 * every route and while scrolling.
 */
function StagingOverlay() {
  const { t } = useTranslation();
  if (!isStagingServer()) {
    return null;
  }
  return (
    <>
      <div aria-hidden="true" className="app-staging-frame" />
      <div role="status" className="app-staging-banner" data-testid="app-staging-banner">
        {t('staging_banner', { defaultValue: STAGING_BANNER_TEXT })}
      </div>
    </>
  );
}

/**
 * Keeps the app unusable until the user has accepted or declined the cookie
 * banner - the banner itself floats on top (see CookieBanner) and stays
 * interactive regardless.
 */
function GatedMain() {
  const { consent } = useConsent();
  const locked = consent === null;
  return (
    <div aria-hidden={locked} className={`app-gated${locked ? ' app-gated--locked' : ''}`} data-testid="app-gated">
      <CoreRoutes />
    </div>
  );
}

// Pages drawn over the whole window, without the portal's frame (its
// 750 px minimum width would make them scroll sideways on a phone).
const FULL_PAGE_PATHS = new Set(['/login']);

function PortalFrame({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  if (FULL_PAGE_PATHS.has(pathname.replace(/\/+$/, '') || '/')) {
    return <>{children}</>;
  }
  // Side padding grows with the window up to 32 px - empty grid columns
  // took 1/12 per side (160 px on a 1920 px screen).
  return (
    <Container fluid={true} className="app-portal-frame" data-testid="app-portal-frame">
      {children}
    </Container>
  );
}

function App() {
  return (
    <>
      <StagingOverlay />
      <MaintenanceGate>
        {/* Toasts bottom right, where they cover the least (not the top bar,
            the page's actions or the sidebar), at most 3 and no repeats. They
            close on click; Toast runs their timer (a progress bar that pauses
            while hovered) - notistack's own is off. */}
        <SnackbarProvider
          maxSnack={3}
          preventDuplicate
          autoHideDuration={null}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          Components={{ default: Toast, success: Toast, error: Toast, warning: Toast, info: Toast }}
        >
          <ConsentProvider>
            <ModalProvider>
              <BrowserRouter>
                <CoreAuthProvider>
                  {/* Usage analysis - only with the backend's flag and consent. */}
                  <ActivityTracking />
                  <PortalFrame>
                    <GatedMain />
                    <CookieBanner />
                  </PortalFrame>
                </CoreAuthProvider>
              </BrowserRouter>
            </ModalProvider>
          </ConsentProvider>
        </SnackbarProvider>
      </MaintenanceGate>
    </>
  );
}
export default App;
