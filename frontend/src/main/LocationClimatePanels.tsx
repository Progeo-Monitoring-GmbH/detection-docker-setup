import { useCallback, useEffect, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import ClimateChart, {
  type ClimateResponse,
} from '../components/device/ClimateChart';
import PanelCard from '../components/ui/kit/PanelCard';
import SegmentedControl from '../components/ui/kit/SegmentedControl';

type ClimateRange = '24h' | '7d' | '30d';
const CLIMATE_RANGE_DAYS: Record<ClimateRange, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
};

type LocationClimatePanelsProps = {
  locationId: number;
};

/**
 * LoRaWAN objects (ProgeoLocation.PROJECT_TYPE_CHOICES.LORAWAN): no samples,
 * so no heatmap - instead humidity and temperature per device, from
 * GET /v1/location/<pk>/climate/.
 */
const LocationClimatePanels = ({ locationId }: LocationClimatePanelsProps) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();

  const [range, setRange] = useState<ClimateRange>('7d');
  const [climate, setClimate] = useState<ClimateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  const loadClimate = useCallback(() => {
    setLoading(true);
    setDenied(false);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/climate/?days=${CLIMATE_RANGE_DAYS[range]}`,
      (response) => {
        setClimate((response?.data || null) as ClimateResponse | null);
        setLoading(false);
      },
      (error) => {
        if (error?.response?.status === 403) {
          setDenied(true);
        } else {
          showRequestError(enqueueSnackbar, 'Could not load climate data', error);
        }
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar, locationId, range]);

  useEffect(() => {
    loadClimate();
  }, [loadClimate]);

  const devices = climate?.devices ?? [];

  const body = (metric: 'humidity' | 'temperature', axisTitle: string, unit: string) =>
    denied ? (
      <div style={{ color: '#8B8383', fontSize: 13 }}>
        {t('status_no_measurement_access')}
      </div>
    ) : loading && !climate ? (
      <div className="d-flex justify-content-center py-5 text-muted">
        <Spinner animation="border" className="me-2" /> {t('ui_loading')}
      </div>
    ) : (
      <ClimateChart
        devices={devices}
        metric={metric}
        axisTitle={axisTitle}
        unit={unit}
        emptyLabel={t('climate_empty')}
      />
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ padding: '2px 2px 0' }}>
        <SegmentedControl
          options={[
            { value: '24h', label: t('status_range_24h') },
            { value: '7d', label: t('status_range_7d') },
            { value: '30d', label: t('status_range_30d') },
          ]}
          value={range}
          onChange={(value) => setRange(value as ClimateRange)}
        />
      </div>
      <PanelCard title={t('climate_humidity_title')}>
        {body('humidity', t('climate_humidity_axis'), '%')}
      </PanelCard>
      <PanelCard title={t('climate_temperature_title')}>
        {body('temperature', t('climate_temperature_axis'), '°C')}
      </PanelCard>
    </div>
  );
};

export default LocationClimatePanels;
