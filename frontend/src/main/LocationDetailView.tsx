import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Breadcrumb, Card, Container, Spinner, Tab, Tabs } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar } from '../components/ui/Snackbar.jsx';
import LocationStatusTab from './LocationStatusTab';
import LocationAnalyseTab from './LocationAnalyseTab';
import LocationNotificationsTab from './LocationNotificationsTab';
import LocationInterfaceTab from './LocationInterfaceTab';

export type LocationDetail = {
  id?: number | null;
  project_id?: number | null;
  name?: string | null;
  address?: string | null;
  city?: string | null;
  plz?: string | null;
  alarm_threshold?: number | null;
  latitude?: number | null;
  longitude?: number | null;
};

const LocationDetailView = () => {
  const { id } = useParams();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();

  const [location, setLocation] = useState<LocationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('status');

  const loadLocation = useCallback(() => {
    if (!id) {
      return;
    }
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
  }, [auth, enqueueSnackbar, id]);

  useEffect(() => {
    setLocation(null);
    loadLocation();
  }, [loadLocation]);

  const locationId = location?.id ?? Number(id);
  const locationLabel = location?.name
    ? `${location.name}${location.project_id != null ? ` (${location.project_id})` : ''}`
    : `Location ${id}`;

  return (
    <Container fluid className="py-3">
      <Breadcrumb>
        <Breadcrumb.Item linkAs={Link} linkProps={{ to: '/' }}>
          Home
        </Breadcrumb.Item>
        <Breadcrumb.Item linkAs={Link} linkProps={{ to: '/location/overview/' }}>
          Locations
        </Breadcrumb.Item>
        <Breadcrumb.Item active>{locationLabel}</Breadcrumb.Item>
      </Breadcrumb>

      <h3 className="mb-3">{locationLabel}</h3>

      {loading ? (
        <Card className="border-0 shadow-sm">
          <Card.Body className="d-flex justify-content-center py-5 text-muted">
            <Spinner animation="border" className="me-2" /> Loading location...
          </Card.Body>
        </Card>
      ) : (
        <Tabs
          activeKey={activeTab}
          onSelect={(key) => setActiveTab(String(key ?? 'status'))}
          mountOnEnter
          className="mb-3"
        >
          <Tab eventKey="status" title="Status">
            <LocationStatusTab location={location} locationId={locationId} />
          </Tab>
          <Tab eventKey="analyse" title="Analyse">
            <LocationAnalyseTab locationId={locationId} />
          </Tab>
          <Tab eventKey="notifications" title="Benachrichtigungen">
            <LocationNotificationsTab locationId={locationId} />
          </Tab>
          <Tab eventKey="interface" title="Schnittstelle">
            <LocationInterfaceTab />
          </Tab>
        </Tabs>
      )}
    </Container>
  );
};

export default LocationDetailView;
