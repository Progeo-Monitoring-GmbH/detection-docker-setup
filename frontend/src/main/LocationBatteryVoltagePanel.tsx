import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import ClimateChart, { type ClimateResponse } from '../components/device/ClimateChart';
import PanelCard from '../components/ui/kit/PanelCard';

type LocationBatteryVoltagePanelProps = {
  locationId: number;
  /** Window of the Zeitreihe it sits under. */
  days: number;
  /** Public demo view: read the series from /v1/demo/. */
  demo?: boolean;
};

/**
 * Battery voltage per device (ProgeoMeasurement.battery_v, sent by IMEI
 * devices), from GET /v1/location/<pk>/climate/. Renders nothing for
 * locations without voltage readings.
 */
const LocationBatteryVoltagePanel = ({
  locationId,
  days,
  demo = false,
}: LocationBatteryVoltagePanelProps) => {
  const auth = useAuth();
  const { t } = useTranslation();
  const [climate, setClimate] = useState<ClimateResponse | null>(null);
  const [hoveredDeviceId, setHoveredDeviceId] = useState<number | null>(null);
  // Only the latest request may land (see LocationClimatePanels).
  const latestRequest = useRef(0);

  useEffect(() => {
    const request = ++latestRequest.current;
    void axiosConfig.perform_get(
      auth,
      `${demo ? '/v1/demo' : '/v1/location'}/${locationId}/climate/?days=${days}`,
      (response) => {
        if (request === latestRequest.current) {
          setClimate((response?.data || null) as ClimateResponse | null);
        }
      },
      // Optional extra panel: no error bar, the Zeitreihe reports its own.
      () => {
        if (request === latestRequest.current) {
          setClimate(null);
        }
      },
    );
  }, [auth, days, demo, locationId]);

  const devices = climate?.devices ?? [];
  if (!devices.some((device) => device.battery_v?.some((value) => value != null))) {
    return null;
  }

  return (
    <PanelCard title={t('climate_battery_v_title')}>
      <ClimateChart
        devices={devices}
        metric="battery_v"
        axisTitle={t('climate_battery_v_axis')}
        unit="V"
        emptyLabel={t('climate_empty')}
        hoveredDeviceId={hoveredDeviceId}
        onHoverDevice={setHoveredDeviceId}
        bucketSeconds={climate?.bucket_seconds ?? null}
      />
    </PanelCard>
  );
};

export default LocationBatteryVoltagePanel;
