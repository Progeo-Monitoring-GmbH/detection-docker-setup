import React from 'react';
import { Col, Container, Row } from 'react-bootstrap';
import { BrowserRouter } from 'react-router';
import { SnackbarProvider } from 'notistack';
import CoreAuthProvider from '../hooks/CoreAuthProvider';
import { ModalProvider } from './components/modal/coreModalContext';
import CookieBanner from './components/privacy/CookieBanner';

import CoreRoutes from './CoreRoutes';

import './i18n';

function App() {
  return (
    <SnackbarProvider
      maxSnack={5}
      dense={true}
      anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
    >
      <ModalProvider>
        <Container fluid={true} style={{ minWidth: '750px', margin: '0' }}>
          <Row>
            <Col md={1} style={{ padding: '0' }}></Col>
            <Col md={10} style={{ padding: '0' }}>
              <BrowserRouter>
                <CoreAuthProvider>
                  <CoreRoutes />
                  <CookieBanner />
                </CoreAuthProvider>
              </BrowserRouter>
            </Col>
            <Col md={1} style={{ padding: '0' }}></Col>
          </Row>
        </Container>
      </ModalProvider>
    </SnackbarProvider>
  );
}
export default App;
