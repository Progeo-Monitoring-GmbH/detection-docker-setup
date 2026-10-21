import { useEffect, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { Navigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import type { LocationDetail } from './locationTypes';

/**
 * Start of the public demo (/demo/, after DemoLogin): opens the first demo
 * location in the regular portal - the demo user sees the same layout as
 * everyone else (sidebar, top bar, profile, language), only read-only (see
 * demo.ts). /demo/location/:id (older links) opens that location.
 */
const DemoView = () => {
  const { id } = useParams();
  const auth = useAuth();
  const { t } = useTranslation();
  const [firstId, setFirstId] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (id) {
      return;
    }
    void axiosConfig.perform_get(
      auth,
      '/v1/demo/',
      (response) => {
        const locations = (response?.data?.locations || []) as LocationDetail[];
        if (locations.length) {
          setFirstId(locations[0].id ?? null);
        } else {
          setFailed(true);
        }
      },
      () => setFailed(true),
    );
    // Loaded once per visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (id) {
    return <Navigate to={`/location/${id}/status`} replace />;
  }
  if (firstId !== null) {
    return <Navigate to={`/location/${firstId}/status`} replace />;
  }
  return (
    <div
      className="d-flex justify-content-center align-items-center text-muted"
      style={{ minHeight: '100vh' }}
    >
      {failed ? (
        t('demo_load_error')
      ) : (
        <>
          <Spinner animation="border" className="me-2" /> {t('ui_loading')}
        </>
      )}
    </div>
  );
};

export default DemoView;
