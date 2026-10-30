import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router';
import { Card, Form, Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { downloadResponse, openResponseInNewTab } from '../helper';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import SensorHeatmap2D from '../components/device/SensorHeatmap2D.tsx';
import { type SensorHeatmapResponse } from '../components/device/sensorHeatmapTypes';
import MeasurementSamplesCompareChart, {
  type MeasurementCompareRow,
  toggledSensor,
} from '../components/device/MeasurementSamplesCompareChart.tsx';
import type { PortalOutletContext } from './LocationPortalLayout';
import LocationClimatePanels from './LocationClimatePanels';
import LocationClimateHeatmap from './LocationClimateHeatmap';
import { isLorawanProject } from './projectType';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import {
  availableTimeRanges,
  effectiveTimeRange,
  TIME_RANGE_DAYS,
  timeRangeCandidates,
  timeRangeLabelKey,
  type TimeRange,
} from './timeRanges';
import useMeasurementRange from './useMeasurementRange';

/** Most measurements per period - spread evenly over it by the backend (?days=). */
const MAX_MEASUREMENTS = 300;

type AnalyseDevice = { id: number; display_name: string };

/**
 * Analyse route: the location heatmap plus the measurements of all its
 * devices over the selected period (last 24 h / 7 / 30 days; staff also the
 * last quarter, half year and year) - only periods the data reaches into.
 * Reuses the existing heatmap + measurement endpoints and components.
 */
const LocationAnalyseTab = () => {
  const { location, locationId } = useOutletContext<PortalOutletContext>();
  // LoRaWAN objects have no samples - a humidity/temperature heatmap of the
  // placed sensors and their charts replace the heatmap and samples chart.
  const isLorawan = isLorawanProject(location?.project_type);
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  // Battery charts are device maintenance - staff (and superusers) only.
  const authUser = auth?.user as { is_staff?: boolean; is_superuser?: boolean } | null;
  const isStaff = Boolean(authUser?.is_staff || authUser?.is_superuser);

  // One period for the heatmap and the charts (also LoRaWAN's); an
  // unavailable selection falls back to the longest offered one.
  const measurementRange = useMeasurementRange(locationId, false);
  const rangeOptions = useMemo(
    () => availableTimeRanges(measurementRange, timeRangeCandidates({ staff: isStaff })),
    [isStaff, measurementRange],
  );
  const [selectedRange, setSelectedRange] = useState<TimeRange>('7d');
  const range = effectiveTimeRange(selectedRange, rangeOptions);
  // The time (epoch ms) of the heatmap's and the measurements' coupled
  // sliders - null: the newest measurement.
  const [frameTime, setFrameTime] = useState<number | null>(null);
  // The sensors (pair index) the measurements' second plot follows - picked
  // there or on the heatmap.
  const [sensors, setSensors] = useState<number[]>([]);
  const [heatmap, setHeatmap] = useState<SensorHeatmapResponse | null>(null);
  const [measurements, setMeasurements] = useState<MeasurementCompareRow[]>([]);
  // Measurements in the period, of which `measurements` are shown.
  const [measurementTotal, setMeasurementTotal] = useState(0);
  // The chart shows one device: the picked one (of this location), else the
  // backend's default - the device that measured last.
  const [devices, setDevices] = useState<AnalyseDevice[]>([]);
  const [shownDevice, setShownDevice] = useState<number | null>(null);
  const [pickedDevice, setPickedDevice] = useState<{ locationId: unknown; id: number } | null>(null);
  const deviceId = pickedDevice?.locationId === locationId ? pickedDevice.id : null;
  const [heatmapLoading, setHeatmapLoading] = useState(true);
  const [measurementsLoading, setMeasurementsLoading] = useState(true);
  // Only the newest request may set the data - switching periods quickly
  // must not let a slower, older response win.
  const heatmapRequest = useRef(0);
  const measurementsRequest = useRef(0);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  // LoRaWAN: the device hovered on the heatmap or in a chart - highlighted in both.
  const [hoveredDeviceId, setHoveredDeviceId] = useState<number | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);

  const exportCsv = () => {
    void openResponseInNewTab(auth, `/v1/location/${locationId}/export_csv/`);
    setExportMsg(t('analyse_export_csv_done'));
  };

  const exportPdf = () => {
    setExportingPdf(true);
    void downloadResponse(
      auth,
      `/v1/location/${locationId}/export_pdf/`,
      `${location?.project_id ?? locationId}-report.pdf`,
    ).then((ok) => {
      setExportingPdf(false);
      if (ok) {
        setExportMsg(t('analyse_export_pdf_done'));
      }
    });
  };

  const query = `days=${TIME_RANGE_DAYS[range]}&limit=${MAX_MEASUREMENTS}`;

  const loadHeatmap = useCallback(() => {
    if (isLorawan) {
      return;
    }
    setHeatmapLoading(true);
    const current = ++heatmapRequest.current;
    const isCurrent = () => current === heatmapRequest.current;
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/heatmap/?${query}`,
      (response) => {
        if (isCurrent()) {
          setHeatmap((response?.data || null) as SensorHeatmapResponse | null);
          setHeatmapLoading(false);
        }
      },
      (error) => {
        if (isCurrent()) {
          showRequestError(enqueueSnackbar, 'Could not load heatmap', error);
          setHeatmapLoading(false);
        }
      },
    );
  }, [auth, enqueueSnackbar, isLorawan, locationId, query]);

  // Switching the device reloads only the measurements.
  const loadMeasurements = useCallback(() => {
    if (isLorawan) {
      return;
    }
    setMeasurementsLoading(true);
    const current = ++measurementsRequest.current;
    const isCurrent = () => current === measurementsRequest.current;
    const device = deviceId != null ? `&device=${deviceId}` : '';
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/measurements/?${query}${device}`,
      (response) => {
        if (isCurrent()) {
          const rows = (response?.data?.measurements ||
            []) as MeasurementCompareRow[];
          setMeasurements(rows);
          setMeasurementTotal(Number(response?.data?.total ?? rows.length));
          setDevices((response?.data?.devices || []) as AnalyseDevice[]);
          setShownDevice((response?.data?.device ?? null) as number | null);
          setMeasurementsLoading(false);
        }
      },
      (error) => {
        if (isCurrent()) {
          showRequestError(enqueueSnackbar, 'Could not load measurements', error);
          setMeasurementsLoading(false);
        }
      },
    );
  }, [auth, deviceId, enqueueSnackbar, isLorawan, locationId, query]);

  useEffect(() => {
    loadHeatmap();
  }, [loadHeatmap]);

  useEffect(() => {
    loadMeasurements();
  }, [loadMeasurements]);

  const loading = heatmapLoading || measurementsLoading;

  return (
    <div className="d-flex flex-column gap-4">
      <div className="d-flex flex-wrap align-items-center gap-3">
        <button
          type="button"
          className="btn btn-outline-secondary btn-sm"
          onClick={exportCsv}
        >
          {t('analyse_export_csv')}
        </button>
        <button
          type="button"
          className="btn btn-outline-secondary btn-sm"
          onClick={exportPdf}
          disabled={exportingPdf}
        >
          {exportingPdf && <Spinner size="sm" animation="border" className="me-2" />}
          {t('analyse_export_pdf')}
        </button>
        {exportMsg && <span className="text-success small">{exportMsg}</span>}
      </div>

      <div className="d-flex flex-wrap align-items-center gap-3">
        <SegmentedControl
          options={rangeOptions.map((value) => ({
            value,
            label: t(timeRangeLabelKey(value)),
          }))}
          value={range}
          onChange={(value) => {
            setSelectedRange(value as TimeRange);
            setFrameTime(null);
          }}
        />
        {!isLorawan && loading && (heatmap || measurements.length > 0) && (
          <Spinner size="sm" animation="border" className="text-muted" />
        )}
      </div>

      {isLorawan ? (
        <>
          <LocationClimateHeatmap
            locationId={locationId}
            range={range}
            hoveredDeviceId={hoveredDeviceId}
            onHoverDevice={setHoveredDeviceId}
          />
          <LocationClimatePanels
            locationId={locationId}
            range={range}
            showBattery={isStaff}
            hoveredDeviceId={hoveredDeviceId}
            onHoverDevice={setHoveredDeviceId}
          />
        </>
      ) : (
        <>
          <Card className="border-0 shadow-sm p-2">
            <Card.Body>
              {heatmapLoading && !heatmap ? (
                <div className="d-flex align-items-center gap-2 text-muted py-4">
                  <Spinner size="sm" animation="border" /> Loading heatmap...
                </div>
              ) : (
                <SensorHeatmap2D
                  response={heatmap}
                  fitPlan
                  hideChrome
                  time={frameTime}
                  onTimeChange={setFrameTime}
                  // pos is the sensor_order: pair index + 1.
                  onSensorClick={(pos) => setSensors((selected) => toggledSensor(selected, pos - 1))}
                />
              )}
            </Card.Body>
          </Card>

          <Card className="border-0 shadow-sm p-2">
            <Card.Body>
              <div className="d-flex flex-wrap align-items-center gap-3 mb-1">
                <h5 className="mb-0">{t('analyse_measurements_title')}</h5>
                {devices.length > 1 && (
                  <Form.Select
                    size="sm"
                    aria-label={t('analyse_device')}
                    title={t('analyse_device')}
                    value={shownDevice ?? ''}
                    onChange={(event) =>
                      setPickedDevice({ locationId, id: Number(event.target.value) })
                    }
                    style={{ width: 'auto', maxWidth: 260 }}
                  >
                    {devices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.display_name}
                      </option>
                    ))}
                  </Form.Select>
                )}
              </div>
              {measurementTotal > measurements.length && (
                <div className="text-muted small mb-2">
                  {t('analyse_spread', {
                    count: measurements.length,
                    total: measurementTotal,
                  })}
                </div>
              )}
              {measurementsLoading && measurements.length === 0 ? (
                <div className="d-flex align-items-center gap-2 text-muted py-4">
                  <Spinner size="sm" animation="border" /> Loading measurements...
                </div>
              ) : measurements.length === 0 ? (
                <div className="text-muted py-4 text-center">
                  {t('analyse_no_measurements')}
                </div>
              ) : (
                <MeasurementSamplesCompareChart
                  rows={measurements}
                  frameSlider
                  sliderPlayKey={false}
                  hideChrome
                  time={frameTime}
                  onTimeChange={setFrameTime}
                  sensors={sensors}
                  onSensorsChange={setSensors}
                />
              )}
            </Card.Body>
          </Card>
        </>
      )}
    </div>
  );
};

export default LocationAnalyseTab;
