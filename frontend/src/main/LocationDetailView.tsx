import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import {
  Card,
  Container,
  Spinner,
  Tab,
  Tabs,
} from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
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

type TabKey = 'status' | 'analyse' | 'notifications' | 'interface';

/** The permission code that unlocks each tab; tabs are hidden when missing. */
const TAB_DEFS: { key: TabKey; title: string; permission: string }[] = [
  { key: 'status', title: 'Status', permission: 'module_locations_enabled' },
  {
    key: 'analyse',
    title: 'Analyse',
    permission: 'module_measurements_enabled',
  },
  {
    key: 'notifications',
    title: 'Benachrichtigungen',
    permission: 'module_notifications_enabled',
  },
  {
    key: 'interface',
    title: 'Schnittstelle',
    permission: 'module_interface_enabled',
  },
];

const LocationDetailView = () => {
  const { id } = useParams();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();

  const [location, setLocation] = useState<LocationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey | ''>('');

  const loadLocation = () => {
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
  };

  useEffect(() => {
    setLocation(null);
    loadLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Tabs the current user is allowed to see.
  const allowedTabs = useMemo(
    () => TAB_DEFS.filter((tab) => hasPermission(tab.permission)),
    [hasPermission],
  );

  // Keep the active tab valid when permissions change (e.g. first allowed).
  useEffect(() => {
    if (allowedTabs.length === 0) {
      return;
    }
    setActiveTab((current) => {
      if (current && allowedTabs.some((tab) => tab.key === current)) {
        return current;
      }
      return allowedTabs[0].key;
    });
  }, [allowedTabs]);

  const locationId = location?.id ?? Number(id);

  const renderTab = (tabKey: TabKey) => {
    switch (tabKey) {
      case 'status':
        return <LocationStatusTab location={location} locationId={locationId} />;
      case 'analyse':
        return <LocationAnalyseTab locationId={locationId} />;
      case 'notifications':
        return <LocationNotificationsTab locationId={locationId} />;
      case 'interface':
        return <LocationInterfaceTab />;
    }
  };

  if (loading || permissionsLoading) {
    return (
      <Container fluid className="py-3">
        <Card className="border-0 shadow-sm">
          <Card.Body className="d-flex justify-content-center py-5 text-muted">
            <Spinner animation="border" className="me-2" /> Loading...
          </Card.Body>
        </Card>
      </Container>
    );
  }

  return (
    <Container fluid className="py-3">
      {allowedTabs.length === 0 ? (
        <Card className="border-0 shadow-sm">
          <Card.Body className="py-5 text-center text-muted">
            Keine Zugriffsberechtigung für die Inhalte dieser Location.
          </Card.Body>
        </Card>
      ) : (
        <Tabs
          activeKey={activeTab || allowedTabs[0].key}
          onSelect={(key) => setActiveTab(String(key ?? '') as TabKey | '')}
          mountOnEnter
          className="mb-3"
        >
          {allowedTabs.map((tab) => (
            <Tab key={tab.key} eventKey={tab.key} title={tab.title}>
              {renderTab(tab.key)}
            </Tab>
          ))}
        </Tabs>
      )}
    </Container>
  );
};

export default LocationDetailView;
