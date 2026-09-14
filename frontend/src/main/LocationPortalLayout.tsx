import { useEffect, useState } from 'react';
import { Outlet, useParams } from 'react-router';
import { Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar } from '../components/ui/Snackbar.jsx';
import LocationSidebar from '../components/sidebar/LocationSidebar';
import TopBar from '../components/topbar/TopBar';
import type { LocationDetail } from './locationTypes';

export type PortalOutletContext = {
  location: LocationDetail | null;
  locationId: number;
};

/**
 * Shell for the object/location monitoring portal: loads the location once
 * (when :id is present), renders the sidebar, and hands location/locationId
 * down to whichever section route is active via <Outlet context>. Replaces
 * the old LocationDetailView.tsx, which did this fetch itself and switched
 * between tabs internally instead of via routes.
 */
const LocationPortalLayout = () => {
  const { id } = useParams();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();

  const [location, setLocation] = useState<LocationDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(id));

  useEffect(() => {
    if (!id) {
      setLocation(null);
      setLoading(false);
      return;
    }
    setLocation(null);
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${id}/`,
      (response) => {
        setLocation((response?.data || null) as LocationDetail | null);
        setLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not load location: ${reason}`);
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const locationId = location?.id ?? Number(id);
  const mobile = typeof window !== 'undefined' && window.innerWidth < 860;

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: mobile ? 'column' : 'row',
        alignItems: mobile ? 'stretch' : 'stretch',
        background: 'var(--progeo-page-bg)',
      }}
    >
      <LocationSidebar location={id ? location : null} locationId={id ? locationId : null} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          padding: mobile ? '4px 12px 20px' : '20px 20px 22px 6px',
        }}
      >
        <TopBar />
        {loading ? (
          <div className="d-flex justify-content-center py-5 text-muted">
            <Spinner animation="border" className="me-2" />
          </div>
        ) : (
          <Outlet context={{ location, locationId } satisfies PortalOutletContext} />
        )}
      </div>
    </div>
  );
};

export default LocationPortalLayout;
