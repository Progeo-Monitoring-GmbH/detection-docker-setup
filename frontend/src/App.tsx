import { Container, Row } from 'react-bootstrap';
import { BrowserRouter } from 'react-router';
import { SnackbarProvider } from 'notistack';
import CoreAuthProvider from '../hooks/CoreAuthProvider';
import { ModalProvider } from './components/modal/coreModalContext';

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
        <Container
          fluid={true}
          style={{ minWidth: '750px', maxWidth: '2160px', margin: '0' }}
        >
          <Row>
            <BrowserRouter>
              <CoreAuthProvider>
                <CoreRoutes />
              </CoreAuthProvider>
            </BrowserRouter>
          </Row>
        </Container>
      </ModalProvider>
    </SnackbarProvider>
  );
}
export default App;
