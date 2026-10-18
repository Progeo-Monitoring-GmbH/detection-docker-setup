import { useEffect, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { Navigate, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import LocationStatusView from './LocationStatusView';
import type { LocationDetail } from './locationTypes';
import { getProjectTypeLabel } from './projectType';

/**
 * Public, read-only demo (/demo/location/:id): the same status view as
 * /location/:id/status, fed by /v1/demo/... and without write actions, in a
 * minimal layout of its own (no sidebar, no navigation into the real portal).
 * Entered through a demo link, see DemoLogin.
 */
const DemoView = () => {
  const { id } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [locations, setLocations] = useState<LocationDetail[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      '/v1/demo/',
      (response) => setLocations((response?.data?.locations || []) as LocationDetail[]),
      () => setFailed(true),
    );
    // Loaded once per visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) {
    return (
      <div className="d-flex justify-content-center align-items-center text-muted" style={{ minHeight: '100vh' }}>
        {t('demo_load_error')}
      </div>
    );
  }
  if (locations === null) {
    return (
      <div className="d-flex justify-content-center align-items-center text-muted" style={{ minHeight: '100vh' }}>
        <Spinner animation="border" className="me-2" /> {t('ui_loading')}
      </div>
    );
  }
  if (!id) {
    return locations.length > 0 ? (
      <Navigate to={`/demo/location/${locations[0].id}`} replace />
    ) : (
      <div className="d-flex justify-content-center align-items-center text-muted" style={{ minHeight: '100vh' }}>
        {t('demo_load_error')}
      </div>
    );
  }

  const locationId = Number(id);
  const current = locations.find((location) => location.id === locationId) ?? null;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--progeo-surface)' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
          padding: '14px 24px',
          background: '#fff',
          borderBottom: '1px solid var(--progeo-track-soft)',
        }}
      >
        <span style={{ fontSize: 20, fontWeight: 600, color: 'var(--progeo-blue)' }}>
          {t('demo_title')}
        </span>
        <span
          style={{
            padding: '2px 10px',
            borderRadius: 999,
            background: 'var(--progeo-orange)',
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {t('demo_badge')}
        </span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
          {locations.map((location) => (
            <button
              key={location.id}
              type="button"
              onClick={() => navigate(`/demo/location/${location.id}`)}
              style={{
                height: 34,
                padding: '0 14px',
                border: 'none',
                borderRadius: 10,
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                background:
                  location.id === locationId ? 'var(--progeo-blue)' : 'var(--progeo-track-soft)',
                color: location.id === locationId ? '#fff' : '#555',
              }}
            >
              {getProjectTypeLabel(t, location.project_type)}
            </button>
          ))}
        </div>
      </header>
      <div style={{ fontSize: 12.5, color: '#8B8383', padding: '10px 24px 0' }}>
        {t('demo_subtitle')}
      </div>
      <main style={{ padding: '14px 24px 32px' }}>
        {current ? (
          <LocationStatusView key={locationId} location={current} locationId={locationId} demo />
        ) : (
          <div className="text-muted">{t('demo_load_error')}</div>
        )}
      </main>
    </div>
  );
};

export default DemoView;
