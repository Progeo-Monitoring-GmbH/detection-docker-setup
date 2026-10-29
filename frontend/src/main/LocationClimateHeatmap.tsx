import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Card, Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import SensorHeatmap2D from '../components/device/SensorHeatmap2D.tsx';
import type { SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import {
  SHORT_TIME_RANGES,
  TIME_RANGE_DAYS,
  timeRangeLabelKey,
  type TimeRange,
} from './timeRanges';

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
 * sensors"), interpolated between them - one frame per hour (24 h, 7 days)
 * or per 4 hours (30 days).
 */
const LocationClimateHeatmap = ({ locationId }: { locationId: number | string }) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();
  const [metric, setMetric] = useState<ClimateMetric>('humidity');
  const [range, setRange] = useState<TimeRange>('7d');
  const [response, setResponse] = useState<ClimateHeatmapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // Only the newest request may set the data (quick toggling).
  const requestId = useRef(0);

  useEffect(() => {
    const current = ++requestId.current;
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/climate-heatmap/?metric=${metric}&days=${TIME_RANGE_DAYS[range]}`,
      (result) => {
        if (current === requestId.current) {
          setResponse((result?.data || null) as ClimateHeatmapResponse | null);
          setLoading(false);
        }
      },
      (error) => {
        if (current === requestId.current) {
          showRequestError(enqueueSnackbar, 'Could not load heatmap', error);
          setLoading(false);
        }
      },
    );
  }, [auth, enqueueSnackbar, locationId, metric, range]);

  const hasPoints = Boolean(response?.sensor_points?.length);

  return (
    <Card className="border-0 shadow-sm p-2">
      <Card.Body className="d-flex flex-column gap-3">
        <div className="d-flex flex-wrap align-items-center gap-3">
          <h5 className="mb-0 me-auto">{t('climate_heatmap_title')}</h5>
          {loading && response && (
            <Spinner size="sm" animation="border" className="text-muted" />
          )}
          <SegmentedControl
            options={(['humidity', 'temperature'] as const).map((value) => ({
              value,
              label: t(METRIC_LABEL_KEYS[value]),
            }))}
            value={metric}
            onChange={(value) => {
              setLoading(true);
              setMetric(value as ClimateMetric);
            }}
          />
          <SegmentedControl
            options={SHORT_TIME_RANGES.map((value) => ({
              value,
              label: t(timeRangeLabelKey(value)),
            }))}
            value={range}
            onChange={(value) => {
              setLoading(true);
              setRange(value as TimeRange);
            }}
          />
        </div>

        {loading && !response ? (
          <div className="d-flex align-items-center gap-2 text-muted py-4">
            <Spinner size="sm" animation="border" /> {t('climate_heatmap_title')}…
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
              field={{ unit: response?.unit ?? '', decimals: 1 }}
            />
            {response?.step != null && (
              <div className="small text-muted">
                {t('climate_heatmap_frames', { hours: response.step / 3600 })}
              </div>
            )}
          </>
        )}
      </Card.Body>
    </Card>
  );
};

export default LocationClimateHeatmap;
