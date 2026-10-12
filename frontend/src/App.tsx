import React from 'react';
import { Col, Container, Row } from 'react-bootstrap';
import { BrowserRouter } from 'react-router';
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

function App() {
  return (
    <SnackbarProvider
      maxSnack={5}
      dense={true}
      anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
    >
      <ConsentProvider>
        <ModalProvider>
          <Container fluid={true} style={{ minWidth: '750px', margin: '0' }}>
            <Row>
              <Col md={1} style={{ padding: '0' }}></Col>
              <Col md={10} style={{ padding: '0' }}>
                <BrowserRouter>
                  <CoreAuthProvider>
                    <GatedMain />
                    <CookieBanner />
                  </CoreAuthProvider>
                </BrowserRouter>
              </Col>
              <Col md={1} style={{ padding: '0' }}></Col>
            </Row>
          </Container>
        </ModalProvider>
      </ConsentProvider>
    </SnackbarProvider>
  );
}
export default App;
