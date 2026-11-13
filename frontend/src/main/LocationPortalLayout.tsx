import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { Outlet, useParams } from 'react-router';
import { Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import LocationSidebar from '../components/sidebar/LocationSidebar';
import TopBar from '../components/topbar/TopBar';
import EscalationBanner from './EscalationBanner';
import FavoriteStar from './FavoriteStar';
import FavoritesBar from './FavoritesBar';
import ImpersonationBanner from './ImpersonationBanner';
import { isStaffUser } from './favorites';
import type { LocationDetail } from './locationTypes';
import { getProjectTypeLabel } from './projectType';
import './LocationPortalLayout.css';

export type PortalOutletContext = {
  location: LocationDetail | null;
  locationId: number;
  setLocation: Dispatch<SetStateAction<LocationDetail | null>>;
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
  const { t } = useTranslation();

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
        showRequestError(enqueueSnackbar, 'Could not load location', error);
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const locationId = location?.id ?? Number(id);
  const mobile = typeof window !== 'undefined' && window.innerWidth < 860;
  const staff = isStaffUser(auth?.user);
  // "#4711 · smartex® dm" and "Street 1, 12345 City" under the name.
  const projectLine = [
    location?.project_id != null ? `#${location.project_id}` : null,
    location?.project_type != null ? getProjectTypeLabel(t, location.project_type) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const addressLine = [location?.address, [location?.plz, location?.city].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');

  return (
    <div className={`portal-layout${mobile ? ' portal-layout--mobile' : ''}`} data-testid="location-portal">
      <LocationSidebar location={id ? location : null} locationId={id ? locationId : null} />
      <div className="portal-content" data-testid="location-portal-content">
        <TopBar />
        <ImpersonationBanner />
        <FavoritesBar />
        {id && !loading && location && (
          // The big star pins the location; staff also see its escalation.
          <div className="d-flex align-items-center gap-3" data-testid="location-portal-header">
            <FavoriteStar locationId={locationId} size={40} />
            {/* Which object this is - on every tab, for everyone (the tabs show no name of their own). */}
            <div className="portal-title" data-testid="portal-location-title">
              <div
                className="fw-semibold text-truncate portal-title-name"
                title={location.name ?? undefined}
                data-testid="location-portal-name"
              >
                {location.name || location.project_id || locationId}
              </div>
              {projectLine && (
                <div className="small text-muted text-truncate" data-testid="location-portal-project">
                  {projectLine}
                </div>
              )}
              {addressLine && (
                <div className="small text-muted text-truncate" title={addressLine} data-testid="location-portal-address">
                  {addressLine}
                </div>
              )}
            </div>
            {staff && (
              <div className="portal-escalation" data-testid="location-portal-escalation">
                <EscalationBanner locationId={locationId} />
              </div>
            )}
          </div>
        )}
        {loading ? (
          <div className="d-flex justify-content-center py-5 text-muted" data-testid="location-portal-loading">
            <Spinner animation="border" className="me-2" />
          </div>
        ) : (
          <Outlet context={{ location, locationId, setLocation } satisfies PortalOutletContext} />
        )}
      </div>
    </div>
  );
};

export default LocationPortalLayout;
