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
import PillSelect from '../components/ui/kit/PillSelect';
import { MEAN_WINDOWS, smoothHeatmap, smoothMeasurements } from './analyseSmoothing';
import {
  type CachedLoad,
  cachedPeriod,
  cutHeatmap,
  cutMeasurements,
  type MeasurementsLoad,
  withLoad,
} from './analyseCache';

/** The resolutions offered: most measurements per period, spread evenly
 * over it by the backend (?days=&limit=, at most 2000). */
const RESOLUTIONS = [300, 600, 1000, 2000] as const;
const DEFAULT_RESOLUTION = RESOLUTIONS[0];

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
  // How many measurements a period is loaded with, and over how many
  // neighbouring ones every value is averaged (1: not) - less noise.
  const [resolution, setResolution] = useState<number>(DEFAULT_RESOLUTION);
  const [meanWindow, setMeanWindow] = useState(1);
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

  const days = TIME_RANGE_DAYS[range];
  const query = `days=${days}&limit=${resolution}`;
  // The loads by period - switching back, or to a shorter period inside a
  // complete longer load, needs no request (analyseCache).
  const heatmapCache = useRef(new Map<string, CachedLoad<SensorHeatmapResponse>[]>());
  const measurementsCache = useRef(new Map<string, CachedLoad<MeasurementsLoad>[]>());

  const loadHeatmap = useCallback(() => {
    if (isLorawan) {
      return;
    }
    const cacheKey = String(locationId);
    const cached = cachedPeriod(heatmapCache.current.get(cacheKey), days, resolution, Date.now(), (value, fromMs) =>
      cutHeatmap(value, fromMs) ?? value,
    );
    const current = ++heatmapRequest.current;
    if (cached) {
      setHeatmap(cached);
      setHeatmapLoading(false);
      return;
    }
    setHeatmapLoading(true);
    const isCurrent = () => current === heatmapRequest.current;
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/heatmap/?${query}`,
      (response) => {
        const data = (response?.data || null) as SensorHeatmapResponse | null;
        if (data) {
          const frames = data.timestamps?.length ?? 0;
          const now = Date.now();
          heatmapCache.current.set(
            cacheKey,
            withLoad(
              heatmapCache.current.get(cacheKey),
              { days, limit: resolution, complete: (data.total ?? frames) <= frames, loadedAt: now, value: data },
              now,
            ),
          );
        }
        if (isCurrent()) {
          setHeatmap(data);
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
  }, [auth, days, enqueueSnackbar, isLorawan, locationId, query, resolution]);

  // Switching the device reloads only the measurements.
  const loadMeasurements = useCallback(() => {
    if (isLorawan) {
      return;
    }
    const show = (load: MeasurementsLoad) => {
      setMeasurements(load.rows);
      setMeasurementTotal(load.total);
      setDevices(load.devices);
      setShownDevice(load.device);
      setMeasurementsLoading(false);
    };
    const cacheKey = `${locationId}:${deviceId ?? 'default'}`;
    const cached = cachedPeriod(measurementsCache.current.get(cacheKey), days, resolution, Date.now(), cutMeasurements);
    const current = ++measurementsRequest.current;
    if (cached) {
      show(cached);
      return;
    }
    setMeasurementsLoading(true);
    const isCurrent = () => current === measurementsRequest.current;
    const device = deviceId != null ? `&device=${deviceId}` : '';
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/measurements/?${query}${device}`,
      (response) => {
        const rows = (response?.data?.measurements || []) as MeasurementCompareRow[];
        const load: MeasurementsLoad = {
          rows,
          total: Number(response?.data?.total ?? rows.length),
          devices: (response?.data?.devices || []) as AnalyseDevice[],
          device: (response?.data?.device ?? null) as number | null,
        };
        const now = Date.now();
        measurementsCache.current.set(
          cacheKey,
          withLoad(
            measurementsCache.current.get(cacheKey),
            { days, limit: resolution, complete: load.total <= rows.length, loadedAt: now, value: load },
            now,
          ),
        );
        if (isCurrent()) {
          show(load);
        }
      },
      (error) => {
        if (isCurrent()) {
          showRequestError(enqueueSnackbar, 'Could not load measurements', error);
          setMeasurementsLoading(false);
        }
      },
    );
  }, [auth, days, deviceId, enqueueSnackbar, isLorawan, locationId, query, resolution]);

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

  // What the heatmap and the charts show: the loads, averaged over
  // `meanWindow` neighbouring measurements.
  const shownHeatmap = useMemo(() => smoothHeatmap(heatmap, meanWindow), [heatmap, meanWindow]);
  const shownMeasurements = useMemo(
    () => smoothMeasurements(measurements, meanWindow),
    [measurements, meanWindow],
  );
  const shownSensorHistory = useMemo(
    () => (sensorHistoryRows ? smoothMeasurements(sensorHistoryRows, meanWindow) : null),
    [sensorHistoryRows, meanWindow],
  );

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

  // A sensor clicked on the plan (pos = sensor_order) is added to the
  // measurements' second plot - as the pair of its device: a location's
  // sensors can be split over devices, each counting its pairs from 1.
  // Shows that device if needed.
  const selectPlanSensor = (pos: number) => {
    const point = heatmap?.sensor_points?.find((candidate) => candidate.pos === pos);
    const pairIndex = (point?.pair ?? pos) - 1;
    const device = point?.device ?? null;
    if (device != null && device !== shownDevice && devices.some((candidate) => candidate.id === device)) {
      setPickedDevice({ locationId, id: device });
      setSensors([pairIndex]);
      return;
    }
    setSensors((selected) =>
      selected.includes(pairIndex) ? selected : [...selected, pairIndex].sort((a, b) => a - b),
    );
  };

  // The period, its resolution and the averaging - in the frame slider
  // (LoRaWAN: only the period, on its own).
  const rangeControl = (
    <div className="d-flex flex-wrap align-items-center gap-2">
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
      {!isLorawan && (
        <>
          <PillSelect
            label={t('analyse_resolution')}
            title={t('analyse_resolution_hint')}
            options={RESOLUTIONS.map((value) => ({
              value: String(value),
              label: t('analyse_resolution_option', { count: value }),
            }))}
            value={String(resolution)}
            onChange={(value) => setResolution(Number(value))}
          />
          <PillSelect
            label={t('analyse_mean')}
            title={t('analyse_mean_hint')}
            options={MEAN_WINDOWS.map((value) => ({
              value: String(value),
              label: value === 1 ? t('analyse_mean_off') : t('analyse_mean_option', { count: value }),
            }))}
            value={String(meanWindow)}
            onChange={(value) => setMeanWindow(Number(value))}
          />
        </>
      )}
      {!isLorawan && loading && (heatmap || measurements.length > 0) && (
        <Spinner size="sm" animation="border" className="text-muted" />
      )}
    </div>
  );

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

      {isLorawan ? (
        <div className="d-flex flex-wrap align-items-center gap-3">{rangeControl}</div>
      ) : (
        // One slider for the heatmap and the measurements, with the period
        // it covers - kept on top while the page scrolls down to the charts.
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
          {frameSeconds.length > 0 ? (
            <FrameSlider
              id="analyse-frame"
              timestamps={frameSeconds}
              index={frameIndex}
              onChange={(index) => setFrameTime(frameSeconds[index] * 1000)}
              visibleRange={chartZoom}
              toolbar={rangeControl}
            />
          ) : (
            <div className="d-flex flex-wrap align-items-center gap-2 py-3">{rangeControl}</div>
          )}
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
                  {heatmapLoading && !shownHeatmap ? (
                    <div className="d-flex justify-content-center align-items-center py-5 text-muted">
                      <Spinner animation="border" className="me-2" /> {t('ui_loading')}
                    </div>
                  ) : showsLines ? (
                    <LocationDmPlan
                      heatmap={shownHeatmap}
                      time={frameTime}
                      onSensorClick={selectPlanSensor}
                    />
                  ) : (
                    <SensorHeatmap2D
                      response={shownHeatmap}
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
                <div className="d-flex justify-content-center align-items-center py-5 text-muted">
                  <Spinner animation="border" className="me-2" /> {t('ui_loading')}
                </div>
              ) : measurements.length === 0 ? (
                <div className="text-muted py-4 text-center">
                  {t('analyse_no_measurements')}
                </div>
              ) : (
                <MeasurementSamplesCompareChart
                  rows={shownMeasurements}
                  frameSlider
                  hideFrameSlider
                  onVisibleRangeChange={setChartZoom}
                  sliderPlayKey={false}
                  hideChrome
                  time={frameTime}
                  onTimeChange={setFrameTime}
                  sensors={sensors}
                  onSensorsChange={setSensors}
                  sensorHistoryRows={offerSensorHistory ? shownSensorHistory : null}
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
