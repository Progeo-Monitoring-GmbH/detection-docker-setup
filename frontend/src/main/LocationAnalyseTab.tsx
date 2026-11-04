import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router';
import { Button, Card, Collapse, Form, Spinner } from 'react-bootstrap';
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
import FrameSlider, { frameAt } from '../components/device/FrameSlider';
import { parseTimestamp } from './alarmUtils';
import type { PortalOutletContext } from './LocationPortalLayout';
import LocationClimatePanels from './LocationClimatePanels';
import LocationClimateHeatmap from './LocationClimateHeatmap';
import LocationDmPlan from './LocationDmPlan';
import { isLorawanProject, planVisualization } from './projectType';
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
import { staffFlags } from './access';

/** Most measurements per period - spread evenly over it by the backend (?days=). */
const MAX_MEASUREMENTS = 300;

/** Staff: the selected sensors' history (second plot) - the last 3 months,
 * in as many measurements as the backend gives (its limit). */
const SENSOR_HISTORY_DAYS = TIME_RANGE_DAYS['90d'];
const MAX_HISTORY_MEASUREMENTS = 2000;

type AnalyseDevice = { id: number; display_name: string };

/** Where the frame slider sticks while the page scrolls (px from the top) -
 * on mobile below the sticky navigation bar. */
const STICKY_TOP = 0;
const STICKY_TOP_MOBILE = 60;
const MOBILE_WIDTH = 860;

/** Frame steps of the arrow keys: ←/→ one frame, ↑/↓ ten. */
const FRAME_KEY_STEPS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: 10,
  ArrowDown: -10,
};

/** Keys typed into a form control keep their normal meaning. */
const isFormTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  // The frame slider is a range input: the global handler owns its arrows
  // too (preventing the browser's own one-step move, so ↑/↓ can do 10).
  if (target instanceof HTMLInputElement && target.type === 'range') {
    return false;
  }
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
};

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
  // smartex® dm: the sensors are band lines on the plan - no heat field.
  const showsLines = planVisualization(location?.project_type) === 'lines';
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  // Battery charts are device maintenance - staff (and superusers) only.
  const isStaff = staffFlags(auth?.user).isStaffOrSuperuser;

  // One period for the heatmap and the charts (also LoRaWAN's); an
  // unavailable selection falls back to the longest offered one.
  const measurementRange = useMeasurementRange(locationId, false);
  const rangeOptions = useMemo(
    () => availableTimeRanges(measurementRange, timeRangeCandidates({ staff: isStaff })),
    [isStaff, measurementRange],
  );
  const [selectedRange, setSelectedRange] = useState<TimeRange>('7d');
  const range = effectiveTimeRange(selectedRange, rangeOptions);
  // The time (epoch ms) of the page's one frame slider - the heatmap and the
  // measurements show the frame holding it. null: the newest measurement.
  const [frameTime, setFrameTime] = useState<number | null>(null);
  // The measurements' zoomed time span - a band on the slider.
  const [chartZoom, setChartZoom] = useState<{ from: number; to: number } | null>(null);
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
  // The heatmap card is foldable - its height is the page's largest block.
  const [heatmapOpen, setHeatmapOpen] = useState(true);
  // Only the newest request may set the data - switching periods quickly
  // must not let a slower, older response win.
  const heatmapRequest = useRef(0);
  const measurementsRequest = useRef(0);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  // LoRaWAN: the device hovered on the heatmap or in a chart - highlighted in both.
  const [hoveredDeviceId, setHoveredDeviceId] = useState<number | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  // Staff: the shown device's last 3 months for the second plot - by
  // location and device, so another one's history is never shown.
  const [sensorHistory, setSensorHistory] = useState<{ key: string; rows: MeasurementCompareRow[] } | null>(null);
  const [sensorHistoryLoading, setSensorHistoryLoading] = useState(false);
  const sensorHistoryRequest = useRef(0);
  const sensorHistoryKey = `${locationId}:${shownDevice}`;
  const sensorHistoryRows = sensorHistory?.key === sensorHistoryKey ? sensorHistory.rows : null;
  // Not while the period itself already reaches as far back.
  const offerSensorHistory = isStaff && TIME_RANGE_DAYS[range] < SENSOR_HISTORY_DAYS;

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

  const toggleSensorHistory = () => {
    if (sensorHistoryRows) {
      setSensorHistory(null);
      return;
    }
    setSensorHistoryLoading(true);
    const current = ++sensorHistoryRequest.current;
    const key = sensorHistoryKey;
    const device = shownDevice != null ? `&device=${shownDevice}` : '';
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/measurements/?days=${SENSOR_HISTORY_DAYS}&limit=${MAX_HISTORY_MEASUREMENTS}${device}`,
      (response) => {
        if (current === sensorHistoryRequest.current) {
          setSensorHistory({ key, rows: (response?.data?.measurements || []) as MeasurementCompareRow[] });
          setSensorHistoryLoading(false);
        }
      },
      (error) => {
        if (current === sensorHistoryRequest.current) {
          showRequestError(enqueueSnackbar, 'Could not load the sensor history', error);
          setSensorHistoryLoading(false);
        }
      },
    );
  };

  useEffect(() => {
    loadHeatmap();
  }, [loadHeatmap]);

  useEffect(() => {
    loadMeasurements();
  }, [loadMeasurements]);

  // The slider's frames: the heatmap's - the measurements (sampled a little
  // differently) show the one nearest to it; without a heatmap theirs.
  const heatmapFrames = useMemo(
    () => [...(heatmap?.timestamps ?? [])].sort((a, b) => a - b),
    [heatmap],
  );
  const chartFrames = useMemo(
    () =>
      measurements
        .flatMap((row) => {
          const ms = parseTimestamp(row.last_fetched);
          return ms == null ? [] : [ms / 1000];
        })
        .sort((a, b) => a - b),
    [measurements],
  );
  const frameSeconds = heatmapFrames.length ? heatmapFrames : chartFrames;
  const frameIndex =
    frameTime == null ? frameSeconds.length - 1 : frameAt(frameSeconds, frameTime);
  const mobile = typeof window !== 'undefined' && window.innerWidth < MOBILE_WIDTH;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const step = FRAME_KEY_STEPS[event.key];
      if (
        step == null ||
        !frameSeconds.length ||
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey ||
        isFormTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      const last = frameSeconds.length - 1;
      const current =
        frameTime == null ? last : frameAt(frameSeconds, frameTime);
      const next = Math.min(Math.max(current + step, 0), last);
      if (next !== current) {
        setFrameTime(frameSeconds[next] * 1000);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [frameSeconds, frameTime]);

  const loading = heatmapLoading || measurementsLoading;

  // A sensor clicked on the plan (pos = sensor_order) -> the pair of its
  // device in the samples chart: a location's sensors can be split over
  // devices, each counting its pairs from 1. Shows that device if needed.
  const selectPlanSensor = (pos: number) => {
    const point = heatmap?.sensor_points?.find((candidate) => candidate.pos === pos);
    const pairIndex = (point?.pair ?? pos) - 1;
    const device = point?.device ?? null;
    if (device != null && device !== shownDevice && devices.some((candidate) => candidate.id === device)) {
      setPickedDevice({ locationId, id: device });
      setSensors([pairIndex]);
      return;
    }
    setSensors((selected) => toggledSensor(selected, pairIndex));
  };

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

      {!isLorawan && frameSeconds.length > 0 && (
        // One slider for the heatmap and the measurements, kept on top while
        // the page scrolls down to the charts.
        <div
          data-testid="analyse-frame-slider"
          className="px-3"
          style={{
            position: 'sticky',
            top: mobile ? STICKY_TOP_MOBILE : STICKY_TOP,
            zIndex: 50,
            background: 'var(--progeo-panel-bg)',
            borderRadius: 'var(--progeo-radius-panel)',
            boxShadow: 'var(--progeo-shadow-panel)',
          }}
        >
          <FrameSlider
            id="analyse-frame"
            timestamps={frameSeconds}
            index={frameIndex}
            onChange={(index) => setFrameTime(frameSeconds[index] * 1000)}
            visibleRange={chartZoom}
          />
        </div>
      )}

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
          <Card className="border-0 shadow-sm">
            <Card.Header className="bg-transparent border-0 pt-2 pb-1">
              <Button
                variant="link"
                className="p-0 text-decoration-none fw-semibold"
                style={{ color: 'var(--progeo-blue)' }}
                aria-expanded={heatmapOpen}
                aria-controls="analyse-heatmap"
                onClick={() => setHeatmapOpen((open) => !open)}
              >
                <span className="me-2">{heatmapOpen ? '▾' : '▸'}</span>
                {t('analyse_heatmap_title')}
              </Button>
              {heatmapLoading && (
                <Spinner size="sm" animation="border" className="ms-2 text-muted" />
              )}
            </Card.Header>
            <Collapse in={heatmapOpen}>
              <div id="analyse-heatmap">
                <Card.Body className="pt-1">
                  {heatmapLoading && !heatmap ? (
                    <div className="d-flex align-items-center gap-2 text-muted py-4">
                      <Spinner size="sm" animation="border" /> Loading heatmap...
                    </div>
                  ) : showsLines ? (
                    <LocationDmPlan
                      heatmap={heatmap}
                      time={frameTime}
                      onSensorClick={selectPlanSensor}
                    />
                  ) : (
                    <SensorHeatmap2D
                      response={heatmap}
                      fitPlan
                      hideChrome
                      time={frameTime}
                      onTimeChange={setFrameTime}
                      hideFrameSlider
                      onSensorClick={selectPlanSensor}
                    />
                  )}
                </Card.Body>
              </div>
            </Collapse>
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
                  hideFrameSlider
                  onVisibleRangeChange={setChartZoom}
                  sliderPlayKey={false}
                  hideChrome
                  time={frameTime}
                  onTimeChange={setFrameTime}
                  sensors={sensors}
                  onSensorsChange={setSensors}
                  sensorHistoryRows={offerSensorHistory ? sensorHistoryRows : null}
                  onToggleSensorHistory={offerSensorHistory ? toggleSensorHistory : null}
                  isLoadingSensorHistory={sensorHistoryLoading}
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
