import { useCallback, useEffect, useRef, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PillButton from '../components/ui/kit/PillButton';
import DeviceRenameModal from '../components/modal/DeviceRenameModal';
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
  /** Public demo view: read the series from /v1/demo/. */
  demo?: boolean;
};

/**
 * LoRaWAN objects (ProgeoLocation.PROJECT_TYPE_CHOICES.LORAWAN): no samples,
 * so no heatmap - instead humidity and temperature per device, from
 * GET /v1/location/<pk>/climate/.
 */
const LocationClimatePanels = ({ locationId, demo = false }: LocationClimatePanelsProps) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();

  const [range, setRange] = useState<ClimateRange>('7d');
  const [climate, setClimate] = useState<ClimateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [hoveredDeviceId, setHoveredDeviceId] = useState<number | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [renameOpen, setRenameOpen] = useState(false);

  const loadClimate = useCallback(() => {
    setLoading(true);
    setDenied(false);
    void axiosConfig.perform_get(
      auth,
      `${demo ? '/v1/demo' : '/v1/location'}/${locationId}/climate/?days=${CLIMATE_RANGE_DAYS[range]}`,
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
  }, [auth, demo, enqueueSnackbar, locationId, range]);

  useEffect(() => {
    loadClimate();
  }, [loadClimate]);

  const devices = climate?.devices ?? [];

  const isSuperuser =
    !demo && Boolean((auth?.user as { is_superuser?: boolean } | null)?.is_superuser);
  const [busy, setBusy] = useState(false);

  const cleanMeasurements = () => {
    if (!window.confirm(t('measurements_clean_confirm'))) {
      return;
    }
    setBusy(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/measurements/clean/`,
      {},
      (response) => {
        showSuccessBar(
          enqueueSnackbar,
          t('measurements_clean_done', { count: response?.data?.deleted ?? 0 }),
        );
        setBusy(false);
        loadClimate();
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not delete measurements', error);
        setBusy(false);
      },
    );
  };

  const exportMeasurements = () => {
    setBusy(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/measurements/export/`,
      (response) => {
        const url = URL.createObjectURL(new Blob([response.data], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `measurements_location_${locationId}.json`;
        link.click();
        URL.revokeObjectURL(url);
        setBusy(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not export measurements', error);
        setBusy(false);
      },
      { responseType: 'blob' },
    );
  };

  const importMeasurements = (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    setBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(reader.result));
      } catch {
        showErrorBar(enqueueSnackbar, 'File is not valid JSON');
        setBusy(false);
        return;
      }
      void axiosConfig.perform_post(
        auth,
        `/v1/location/${locationId}/measurements/import/`,
        payload,
        (response) => {
          showSuccessBar(
            enqueueSnackbar,
            t('anlegen_import_done', {
              created: response?.data?.created ?? 0,
              updated: response?.data?.updated ?? 0,
            }),
          );
          setBusy(false);
          loadClimate();
        },
        (error) => {
          showRequestError(enqueueSnackbar, 'Could not import measurements', error);
          setBusy(false);
        },
      );
    };
    reader.readAsText(files[0]);
  };

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
        hoveredDeviceId={hoveredDeviceId}
        onHoverDevice={setHoveredDeviceId}
      />
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ padding: '2px 2px 0', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <SegmentedControl
          options={[
            { value: '24h', label: t('status_range_24h') },
            { value: '7d', label: t('status_range_7d') },
            { value: '30d', label: t('status_range_30d') },
          ]}
          value={range}
          onChange={(value) => setRange(value as ClimateRange)}
        />
        {isSuperuser && (
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <PillButton
              variant="ghost"
              label={t('device_rename_title')}
              disabled={busy}
              onClick={() => setRenameOpen(true)}
            />
            <PillButton
              variant="ghost"
              label={t('measurements_export')}
              disabled={busy}
              onClick={exportMeasurements}
            />
            <PillButton
              variant="ghost"
              label={t('measurements_import')}
              disabled={busy}
              onClick={() => importInputRef.current?.click()}
            />
            <input
              ref={importInputRef}
              type="file"
              accept="application/json"
              style={{ display: 'none' }}
              onChange={(event) => {
                importMeasurements(event.target.files);
                event.target.value = '';
              }}
            />
            <PillButton
              variant="ghost"
              label={t('measurements_clean')}
              disabled={busy}
              onClick={cleanMeasurements}
            />
          </div>
        )}
      </div>
      <PanelCard title={t('climate_humidity_title')}>
        {body('humidity', t('climate_humidity_axis'), '%')}
      </PanelCard>
      <PanelCard title={t('climate_temperature_title')}>
        {body('temperature', t('climate_temperature_axis'), '°C')}
      </PanelCard>
      {isSuperuser && (
        <DeviceRenameModal
          show={renameOpen}
          locationId={locationId}
          onClose={() => setRenameOpen(false)}
          onSaved={loadClimate}
        />
      )}
    </div>
  );
};

export default LocationClimatePanels;
