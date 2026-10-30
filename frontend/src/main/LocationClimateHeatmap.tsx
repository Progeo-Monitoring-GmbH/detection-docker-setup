import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import SensorHeatmap2D from '../components/device/SensorHeatmap2D.tsx';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import PanelCard from '../components/ui/kit/PanelCard';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import { TIME_RANGE_DAYS, type TimeRange } from './timeRanges';

type ClimateMetric = 'humidity' | 'temperature';

/** GET /v1/location/<pk>/climate-heatmap/ (LocationViewSet.climate_heatmap). */
type ClimateHeatmapResponse = SensorHeatmapResponse & {
  metric?: ClimateMetric;
  unit?: string;
};

const METRIC_LABEL_KEYS: Record<ClimateMetric, string> = {
  humidity: 'climate_humidity_title',
  temperature: 'climate_temperature_title',
};

/**
 * Heatmap of a LoRaWAN location (Analyse tab): humidity or temperature of
 * the sensors placed on the Lageplan (Lageplan wizard, "Manually set
 * sensors"), interpolated between them over the Analyse tab's range - one
 * frame per hour (24 h, 7 days) or per 4 hours (30 days).
 */
type LocationClimateHeatmapProps = {
  locationId: number | string;
  /** The range picked in the Analyse tab - shared with the climate charts. */
  range: TimeRange;
  /** Device hovered in the climate charts - its marker is highlighted. */
  hoveredDeviceId?: number | null;
  /** Called with the device of the hovered marker (null when left). */
  onHoverDevice?: (deviceId: number | null) => void;
};

const LocationClimateHeatmap = ({
  locationId,
  range,
  hoveredDeviceId = null,
  onHoverDevice,
}: LocationClimateHeatmapProps) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();
  const [metric, setMetric] = useState<ClimateMetric>('humidity');
  const [response, setResponse] = useState<ClimateHeatmapResponse | null>(null);
  // The request (metric + range) the response belongs to - another one is loading.
  const request = `metric=${metric}&days=${TIME_RANGE_DAYS[range]}`;
  const [loadedRequest, setLoadedRequest] = useState<string | null>(null);
  const loading = loadedRequest !== request;
  // Only the newest request may set the data (quick toggling).
  const requestId = useRef(0);

  useEffect(() => {
    const current = ++requestId.current;
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/climate-heatmap/?${request}`,
      (result) => {
        if (current === requestId.current) {
          setResponse((result?.data || null) as ClimateHeatmapResponse | null);
          setLoadedRequest(request);
        }
      },
      (error) => {
        if (current === requestId.current) {
          showRequestError(enqueueSnackbar, 'Could not load heatmap', error);
          setLoadedRequest(request);
        }
      },
    );
  }, [auth, enqueueSnackbar, locationId, request]);

  const hasPoints = Boolean(response?.sensor_points?.length);

  return (
    <PanelCard>
      <div className="d-flex flex-column gap-2">
        <div className="d-flex flex-wrap align-items-center gap-3">
          <SegmentedControl
            options={(['humidity', 'temperature'] as const).map((value) => ({
              value,
              label: t(METRIC_LABEL_KEYS[value]),
            }))}
            value={metric}
            onChange={(value) => setMetric(value as ClimateMetric)}
          />
          {loading && response && (
            <Spinner size="sm" animation="border" className="text-muted" />
          )}
        </div>

        {loading && !response ? (
          <div className="d-flex align-items-center gap-2 text-muted py-4">
            <Spinner size="sm" animation="border" /> {t('ui_loading')}
          </div>
        ) : !hasPoints ? (
          <div className="text-muted py-4 text-center">
            {t('climate_heatmap_no_points')}
            {hasPermission('module_devices_edit') && (
              <div className="mt-2">
                <Link to="/lageplan/wizard/">{t('climate_heatmap_open_wizard')}</Link>
              </div>
            )}
          </div>
        ) : (
          <>
            <SensorHeatmap2D
              response={response}
              hideChrome
              fitPlan
              field={{ unit: response?.unit ?? '', decimals: 1 }}
              highlightedDevice={hoveredDeviceId}
              onHoverDevice={onHoverDevice}
            />
            {response?.step != null && (
              <div className="small text-muted">
                {t('climate_heatmap_frames', { hours: response.step / 3600 })}
              </div>
            )}
          </>
        )}
      </div>
    </PanelCard>
  );
};

export default LocationClimateHeatmap;
