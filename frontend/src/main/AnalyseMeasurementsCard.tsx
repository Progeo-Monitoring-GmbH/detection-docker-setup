import { Button, Card, Form, Spinner } from 'react-bootstrap';
import { ToggleOff, ToggleOn } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import MeasurementSamplesCompareChart, {
  type MeasurementCompareRow,
} from '../components/device/MeasurementSamplesCompareChart.tsx';
import type { ProfileRange } from './NoiseProfilePanel';

type AnalyseMeasurementsCardProps = {
  devices: { id: number; display_name: string }[];
  shownDevice: number | null;
  onDeviceChange: (device: number) => void;
  canSwitchSensors: boolean;
  sensors: number[];
  selectedEnabled: number[];
  selectedDisabled: number[];
  switchingSensors: boolean;
  onRequestDisable: () => void;
  onEnable: () => void;
  measurementTotal: number;
  measurements: MeasurementCompareRow[];
  measurementsLoading: boolean;
  shownMeasurements: MeasurementCompareRow[];
  onChartZoom: (range: { from: number; to: number } | null) => void;
  frameTime: number | null;
  onFrameTimeChange: (time: number | null) => void;
  onSensorsChange: (sensors: number[]) => void;
  offerSensorHistory: boolean;
  shownSensorHistory: MeasurementCompareRow[] | null;
  sensorHistoryLoading: boolean;
  onToggleSensorHistory: (() => void) | null;
  threshold: number | null;
  sensorThresholds: Map<number, number>;
  disabledSensors: Set<number>;
  maskLines: { ep: number[]; wp: number[] } | null;
  offerNoiseProfiles: boolean;
  profileRange: ProfileRange | null;
  onProfileRangeChange: (range: ProfileRange | null) => void;
};

const AnalyseMeasurementsCard = ({
  devices,
  shownDevice,
  onDeviceChange,
  canSwitchSensors,
  sensors,
  selectedEnabled,
  selectedDisabled,
  switchingSensors,
  onRequestDisable,
  onEnable,
  measurementTotal,
  measurements,
  measurementsLoading,
  shownMeasurements,
  onChartZoom,
  frameTime,
  onFrameTimeChange,
  onSensorsChange,
  offerSensorHistory,
  shownSensorHistory,
  sensorHistoryLoading,
  onToggleSensorHistory,
  threshold,
  sensorThresholds,
  disabledSensors,
  maskLines,
  offerNoiseProfiles,
  profileRange,
  onProfileRangeChange,
}: AnalyseMeasurementsCardProps) => {
  const { t } = useTranslation();

  return (
    <Card className="border-0 shadow-sm p-2" data-testid="analyse-measurements">
      <Card.Body>
        <div className="d-flex flex-wrap align-items-center gap-3 mb-1">
          <h5 className="mb-0">{t('analyse_measurements_title')}</h5>
          {devices.length > 1 && (
            <Form.Select
              size="sm"
              aria-label={t('analyse_device')}
              title={t('analyse_device')}
              value={shownDevice ?? ''}
              onChange={(event) => onDeviceChange(Number(event.target.value))}
              className="analyse-device-select"
              data-testid="analyse-device-select"
            >
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.display_name}
                </option>
              ))}
            </Form.Select>
          )}
          {canSwitchSensors && sensors.length > 0 && (
            <div
              className="d-flex flex-wrap gap-2"
              data-testid="analyse-sensor-switch"
            >
              {selectedEnabled.length > 0 && (
                <Button
                  size="sm"
                  variant="outline-secondary"
                  disabled={switchingSensors}
                  onClick={onRequestDisable}
                  title={t('analyse_sensors_disable_title')}
                  data-testid="analyse-sensor-disable"
                >
                  <ToggleOff className="me-1" />
                  {t('analyse_sensors_disable', {
                    count: selectedEnabled.length,
                  })}
                </Button>
              )}
              {selectedDisabled.length > 0 && (
                <Button
                  size="sm"
                  variant="outline-success"
                  disabled={switchingSensors}
                  onClick={onEnable}
                  title={t('analyse_sensors_enable_title')}
                  data-testid="analyse-sensor-enable"
                >
                  <ToggleOn className="me-1" />
                  {t('analyse_sensors_enable', {
                    count: selectedDisabled.length,
                  })}
                </Button>
              )}
            </div>
          )}
        </div>
        {measurementTotal > measurements.length && (
          <div
            className="text-muted small mb-2"
            data-testid="analyse-measurements-spread"
          >
            {t('analyse_spread', {
              count: measurements.length,
              total: measurementTotal,
            })}
          </div>
        )}
        {measurementsLoading && measurements.length === 0 ? (
          <div
            className="d-flex justify-content-center align-items-center py-5 text-muted"
            data-testid="analyse-measurements-loading"
          >
            <Spinner animation="border" className="me-2" /> {t('ui_loading')}
          </div>
        ) : measurements.length === 0 ? (
          <div
            className="text-muted py-4 text-center"
            data-testid="analyse-measurements-empty"
          >
            {t('analyse_no_measurements')}
          </div>
        ) : (
          <MeasurementSamplesCompareChart
            rows={shownMeasurements}
            frameSlider
            hideFrameSlider
            onVisibleRangeChange={onChartZoom}
            sliderPlayKey={false}
            hideChrome
            time={frameTime}
            onTimeChange={onFrameTimeChange}
            sensors={sensors}
            onSensorsChange={onSensorsChange}
            sensorHistoryRows={offerSensorHistory ? shownSensorHistory : null}
            onToggleSensorHistory={
              offerSensorHistory ? onToggleSensorHistory : null
            }
            isLoadingSensorHistory={sensorHistoryLoading}
            threshold={threshold}
            sensorThresholds={sensorThresholds}
            disabledSensors={disabledSensors}
            maskLines={maskLines}
            selectedRange={offerNoiseProfiles ? profileRange : null}
            onRangeSelect={offerNoiseProfiles ? onProfileRangeChange : null}
          />
        )}
      </Card.Body>
    </Card>
  );
};

export default AnalyseMeasurementsCard;
