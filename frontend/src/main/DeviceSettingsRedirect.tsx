import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Container, Spinner } from 'react-bootstrap';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';

/**
 * The old /device/:id/update/ config page now lives in the device's
 * location under Einstellungen > Systemeinstellungen - forward stray
 * bookmarks/links there (or to the device list if it has no location).
 */
const DeviceSettingsRedirect = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      `/v1/device/${id}/`,
      (response) => {
        const location = response?.data?.location as number | null | undefined;
        navigate(
          location ? `/location/${location}/einstellungen` : '/device/overview/',
          { replace: true },
        );
      },
      () => navigate('/device/overview/', { replace: true }),
    );
  }, [auth, id, navigate]);

  return (
    <Container
      className="d-flex justify-content-center align-items-center"
      style={{ minHeight: '50vh' }}
    >
      <Spinner animation="border" role="status">
        <span className="visually-hidden">Loading...</span>
      </Spinner>
    </Container>
  );
};

export default DeviceSettingsRedirect;
