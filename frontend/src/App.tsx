import React from 'react';
import { Col, Container, Row } from 'react-bootstrap';
import { BrowserRouter, useLocation } from 'react-router';
import { SnackbarProvider } from 'notistack';
import CoreAuthProvider from '../hooks/CoreAuthProvider';
import { ModalProvider } from './components/modal/coreModalContext';
import CookieBanner from './components/privacy/CookieBanner';
import { ConsentProvider, useConsent } from './components/privacy/ConsentProvider';

import CoreRoutes from './CoreRoutes';

import './i18n';

/**
 * Keeps the app unusable until the user has accepted or declined the cookie
 * banner - the banner itself floats on top (see CookieBanner) and stays
 * interactive regardless.
 */
function GatedMain() {
  const { consent } = useConsent();
  const locked = consent === null;
  return (
    <div
      aria-hidden={locked}
      style={{
        pointerEvents: locked ? 'none' : 'auto',
        filter: locked ? 'blur(2px)' : 'none',
        userSelect: locked ? 'none' : 'auto',
      }}
    >
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
  return (
    <Container fluid={true} style={{ minWidth: '750px', margin: '0' }}>
      <Row>
        <Col md={1} style={{ padding: '0' }}></Col>
        <Col md={10} style={{ padding: '0' }}>
          {children}
        </Col>
        <Col md={1} style={{ padding: '0' }}></Col>
      </Row>
    </Container>
  );
}

function App() {
  return (
    <SnackbarProvider
      maxSnack={5}
      dense={true}
      anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
    >
      <ConsentProvider>
        <ModalProvider>
          <BrowserRouter>
            <CoreAuthProvider>
              <PortalFrame>
                <GatedMain />
                <CookieBanner />
              </PortalFrame>
            </CoreAuthProvider>
          </BrowserRouter>
        </ModalProvider>
      </ConsentProvider>
    </SnackbarProvider>
  );
}
export default App;
