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
import {
  type HeatProfile,
  heatProfileQuery,
  type SensorHeatmapResponse,
} from '../components/device/sensorHeatmapTypes';
import MeasurementSamplesCompareChart, {
  type MeasurementCompareRow,
  toggledSensor,
} from '../components/device/MeasurementSamplesCompareChart.tsx';
import FrameSlider, { frameAt } from '../components/device/FrameSlider';
import { parseTimestamp } from './alarmUtils';
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
import { staffFlags } from './access';
import PillSelect from '../components/ui/kit/PillSelect';
import { MEAN_WINDOWS, smoothHeatmap, smoothMeasurements } from './analyseSmoothing';
import { compareOffsetsFor, heatmapChange } from './analyseCompare';
import MeasurementComparePlot from '../components/device/MeasurementComparePlot';
import { XLg } from 'react-bootstrap-icons';
import PlotHelp from '../components/ui/PlotHelp';
import KeyHints, { announceKey, type KeyHint } from '../components/ui/KeyHints';
import { downloadBlob } from '../download';
import NoiseProfilePanel, { type NoiseViewState, type ProfileRange } from './NoiseProfilePanel';
import NoiseProfileEditor from './NoiseProfileEditor';
import ThresholdMixerToggle from './ThresholdMixerToggle';
import {
  cleanRows,
  type NoiseProfile,
  type NoiseProfileDraft,
  noiseMaskOf,
  noiseProfileCsv,
  rateNoiseProfile,
  spanParts,
} from './noiseProfiles';

const DAY_MS = 24 * 60 * 60 * 1000;
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
  // Staff: the heatmap's value per sensor (|WP - EP|, WP, EP, WP + EP).
  const [heatProfile, setHeatProfile] = useState<HeatProfile>('diff');
  // The comparison with the past: the same period this many days earlier
  // (null: none) - offered only as far back as the data reaches.
  const [compareDays, setCompareDays] = useState<number | null>(null);
  const [openedAt] = useState(() => Date.now());
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

  // Staff: the Störungsprofile of the location's devices (noiseProfiles.ts).
  // Their measurements are loaded raw (?raw=1) and cleaned here - by the
  // active profile, the one tried out ("Anwenden") or the draft being
  // edited; everyone else gets them cleaned by the backend.
  const offerNoiseProfiles = isStaff && !isLorawan;
  const rawQuery = offerNoiseProfiles ? '&raw=1' : '';
  const [noiseProfileLoad, setNoiseProfileLoad] = useState<{ locationId: unknown; profiles: NoiseProfile[] } | null>(
    null,
  );
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null);
  const [testedProfileId, setTestedProfileId] = useState<number | null>(null);
  // The span a new profile is made from - picked with S + drag on the
  // measurements' time plots, moved / resized under the frame slider.
  const [rangeLoad, setRangeLoad] = useState<{ locationId: unknown; range: ProfileRange } | null>(null);
  const profileRange = rangeLoad?.locationId === locationId ? rangeLoad.range : null;
  const setProfileRange = useCallback(
    (range: ProfileRange | null) => setRangeLoad(range ? { locationId, range } : null),
    [locationId],
  );
  const [draft, setDraft] = useState<NoiseProfileDraft | null>(null);
  const [draftPreview, setDraftPreview] = useState(true);
  const [noiseBusy, setNoiseBusy] = useState(false);
  // Bumped when a profile changed: the heatmap (cleaned by the backend) reloads.
  const [noiseRevision, setNoiseRevision] = useState(0);

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

  // ------------------------------------------------------------- Störungsprofile
  const noiseProfiles = useMemo(
    () => (noiseProfileLoad?.locationId === locationId ? noiseProfileLoad.profiles : []),
    [noiseProfileLoad, locationId],
  );
  // Those of the shown device - a profile belongs to one device.
  const deviceProfiles = useMemo(
    () => noiseProfiles.filter((profile) => profile.device === shownDevice),
    [noiseProfiles, shownDevice],
  );
  const activeProfile = deviceProfiles.find((profile) => profile.is_active) ?? null;
  const testedProfile = deviceProfiles.find((profile) => profile.id === testedProfileId) ?? null;
  // The picked profile, else the active one.
  const selectedProfile = deviceProfiles.find((profile) => profile.id === selectedProfileId) ?? activeProfile;
  const shownDraft = draft && draft.device === shownDevice ? draft : null;
  const noiseView: NoiseViewState = shownDraft
    ? draftPreview
      ? 'draft'
      : 'raw'
    : testedProfile
      ? 'test'
      : activeProfile
        ? 'active'
        : 'none';
  // The mask the measurements are cleaned with here (staff load them raw).
  const displayMask = useMemo(() => {
    if (!offerNoiseProfiles) {
      return null;
    }
    if (noiseView === 'draft') {
      return noiseMaskOf(shownDraft);
    }
    if (noiseView === 'test') {
      return noiseMaskOf(testedProfile);
    }
    return noiseView === 'active' ? noiseMaskOf(activeProfile) : null;
  }, [offerNoiseProfiles, noiseView, shownDraft, testedProfile, activeProfile]);
  // The draft without its preview: the raw values with its masks as lines.
  const maskLines = useMemo(
    () => (offerNoiseProfiles && noiseView === 'raw' && shownDraft ? { ep: shownDraft.mask_e, wp: shownDraft.mask_w } : null),
    [offerNoiseProfiles, noiseView, shownDraft],
  );
  // The heatmap is cleaned by the backend: the raw values, the tried-out
  // profile, else (also for a draft - not saved yet) the active ones.
  const heatNoiseQuery = !offerNoiseProfiles
    ? ''
    : noiseView === 'raw'
      ? '&raw=1'
      : noiseView === 'test' && testedProfile
        ? `&noise_profile=${testedProfile.id}`
        : '';

  const loadHeatmap = useCallback(() => {
    if (isLorawan) {
      return;
    }
    const cacheKey = `${locationId}:${heatProfile}:${heatNoiseQuery}`;
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
      `/v1/location/${locationId}/heatmap/?${query}${heatProfileQuery(heatProfile)}${heatNoiseQuery}`,
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
    // noiseRevision: a changed profile - the cache was cleared, load again.
  }, [auth, days, enqueueSnackbar, heatProfile, heatNoiseQuery, isLorawan, locationId, noiseRevision, query, resolution]);

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
      `/v1/location/${locationId}/measurements/?${query}${device}${rawQuery}`,
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
  }, [auth, days, deviceId, enqueueSnackbar, isLorawan, locationId, query, rawQuery, resolution]);

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
      `/v1/location/${locationId}/measurements/?days=${SENSOR_HISTORY_DAYS}&limit=${MAX_HISTORY_MEASUREMENTS}${device}${rawQuery}`,
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
  // Cleaned first (staff: by displayMask), then smoothed.
  const shownMeasurements = useMemo(
    () => smoothMeasurements(cleanRows(measurements, displayMask), meanWindow),
    [measurements, displayMask, meanWindow],
  );
  const shownSensorHistory = useMemo(
    () => (sensorHistoryRows ? smoothMeasurements(cleanRows(sensorHistoryRows, displayMask), meanWindow) : null),
    [sensorHistoryRows, displayMask, meanWindow],
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
  // LoRaWAN: the climate heatmap's frames, without one the charts' readings.
  const [climateHeatmapFrames, setClimateHeatmapFrames] = useState<number[]>([]);
  const [climateChartFrames, setClimateChartFrames] = useState<number[]>([]);
  const frameSeconds = isLorawan
    ? climateHeatmapFrames.length
      ? climateHeatmapFrames
      : climateChartFrames
    : heatmapFrames.length
      ? heatmapFrames
      : chartFrames;
  const frameIndex =
    frameTime == null ? frameSeconds.length - 1 : frameAt(frameSeconds, frameTime);
  const mobile = typeof window !== 'undefined' && window.innerWidth < MOBILE_WIDTH;
  // The keys of the whole page (the profile plot lists its own).
  const pageKeyHints: KeyHint[] = [
    { id: 'play', keys: [t('key_space')], label: t('key_hint_play') },
    { id: 'frame-step', keys: ['← / →'], label: t('key_hint_frame_step') },
    { id: 'frame-jump', keys: ['↑ / ↓'], label: t('key_hint_frame_jump') },
    ...(offerNoiseProfiles
      ? [{ id: 'range-select', keys: ['S', t('key_drag')], label: t('key_hint_range_select') }]
      : []),
    { keys: [t('key_ctrl'), t('key_wheel')], label: t('key_hint_zoom') },
  ];

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
      announceKey(Math.abs(step) === 1 ? 'frame-step' : 'frame-jump');
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

  // ---------------------------------------------------------------- comparison
  const compareOptions = useMemo(
    () => compareOffsetsFor(measurementRange?.first, days, openedAt),
    [measurementRange, days, openedAt],
  );
  const compare = compareOptions.find((offset) => offset.days === compareDays) ?? null;
  const compareOffsetMs = compare ? compare.days * DAY_MS : 0;
  // The comparison's loads, for the settings they were loaded with.
  const compareKey = compare
    ? `${locationId}:${compare.days}:${days}:${resolution}:${heatProfile}:${shownDevice}:${heatNoiseQuery}:${noiseRevision}`
    : null;
  const [compareHeatmap, setCompareHeatmap] = useState<{ key: string; value: SensorHeatmapResponse | null } | null>(null);
  const [compareRows, setCompareRows] = useState<{ key: string; rows: MeasurementCompareRow[] } | null>(null);
  const compareRequest = useRef(0);
  const loadCompare = useCallback(() => {
    if (!compare || !compareKey || isLorawan) {
      return;
    }
    const current = ++compareRequest.current;
    const isCurrent = () => current === compareRequest.current;
    // The same period, ending `compare.days` ago.
    const to = encodeURIComponent(new Date(Date.now() - compare.days * DAY_MS).toISOString());
    const period = `days=${days}&limit=${resolution}&to=${to}`;
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/heatmap/?${period}${heatProfileQuery(heatProfile)}${heatNoiseQuery}`,
      (response) => {
        if (isCurrent()) {
          setCompareHeatmap({ key: compareKey, value: (response?.data || null) as SensorHeatmapResponse | null });
        }
      },
      (error) => {
        if (isCurrent()) {
          showRequestError(enqueueSnackbar, 'Could not load the comparison', error);
          setCompareHeatmap({ key: compareKey, value: null });
        }
      },
    );
    const device = shownDevice != null ? `&device=${shownDevice}` : '';
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/measurements/?${period}${device}${rawQuery}`,
      (response) => {
        if (isCurrent()) {
          setCompareRows({ key: compareKey, rows: (response?.data?.measurements || []) as MeasurementCompareRow[] });
        }
      },
      (error) => {
        if (isCurrent()) {
          showRequestError(enqueueSnackbar, 'Could not load the comparison', error);
          setCompareRows({ key: compareKey, rows: [] });
        }
      },
    );
  }, [
    auth,
    compare,
    compareKey,
    days,
    enqueueSnackbar,
    heatNoiseQuery,
    heatProfile,
    isLorawan,
    locationId,
    rawQuery,
    resolution,
    shownDevice,
  ]);

  useEffect(() => {
    loadCompare();
  }, [loadCompare]);

  const compareHeatmapShown = compareHeatmap?.key === compareKey ? compareHeatmap.value : null;
  const compareRowsShown = useMemo(
    () =>
      compareRows?.key === compareKey ? smoothMeasurements(cleanRows(compareRows.rows, displayMask), meanWindow) : null,
    [compareRows, compareKey, displayMask, meanWindow],
  );
  const compareLoading =
    compare != null && (compareHeatmap?.key !== compareKey || compareRows?.key !== compareKey);
  // The heatmap while comparing: every sensor's change since then.
  const changeHeatmap = useMemo(
    () =>
      compare && compareHeatmapShown
        ? heatmapChange(shownHeatmap, smoothHeatmap(compareHeatmapShown, meanWindow), compareOffsetMs)
        : null,
    [compare, compareHeatmapShown, shownHeatmap, meanWindow, compareOffsetMs],
  );
  const compareLabel = compare ? t(`analyse_compare_${compare.key}`) : '';

  // A sensor clicked on the plan (pos = sensor_order) is added to the
  // measurements' second plot - as the pair of its device: a location's
  // sensors can be split over devices, each counting its pairs from 1.
  // Shows that device if needed.
  // The plan's sensors (pos) of the second plot's selection: the pairs of
  // the shown device - drawn with a pink border, in sync with the plot.
  const selectedPositions = useMemo(
    () =>
      (heatmap?.sensor_points ?? []).flatMap((point) => {
        const ofShown = point.device == null || point.device === shownDevice;
        return ofShown && sensors.includes((point.pair ?? point.pos) - 1) ? [point.pos] : [];
      }),
    [heatmap, sensors, shownDevice],
  );

  // The alarm thresholds on the first measurement plot: the location's, and
  // the own ones of the shown device's sensors (pair index).
  const alarmThreshold = heatmap?.location?.alarm_threshold ?? location?.alarm_threshold ?? null;
  const sensorThresholds = useMemo(
    () =>
      new Map(
        (heatmap?.sensor_points ?? []).flatMap((point) => {
          const ofShown = point.device == null || point.device === shownDevice;
          return ofShown && point.threshold != null ? [[(point.pair ?? point.pos) - 1, point.threshold] as const] : [];
        }),
      ),
    [heatmap, shownDevice],
  );

  // ------------------------------------------------------------- Störungsprofile
  const loadNoiseProfiles = useCallback(() => {
    if (!offerNoiseProfiles) {
      return;
    }
    const forLocation = locationId;
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/noise-profiles/`,
      (response) =>
        setNoiseProfileLoad({ locationId: forLocation, profiles: (response?.data?.profiles || []) as NoiseProfile[] }),
      (error) => showRequestError(enqueueSnackbar, t('noise_profile_error'), error),
    );
  }, [auth, enqueueSnackbar, locationId, offerNoiseProfiles, t]);

  useEffect(() => {
    loadNoiseProfiles();
  }, [loadNoiseProfiles]);

  // Every profile of the shown device (and the draft) rated for the loaded
  // raw measurements - against the alarm thresholds of their sensors.
  const thresholdOf = useCallback(
    (pair: number) => sensorThresholds.get(pair) ?? alarmThreshold ?? null,
    [sensorThresholds, alarmThreshold],
  );
  const noiseRatings = useMemo(
    () =>
      new Map(
        offerNoiseProfiles
          ? deviceProfiles.map((profile) => [profile.id, rateNoiseProfile(measurements, noiseMaskOf(profile), thresholdOf)])
          : [],
      ),
    [offerNoiseProfiles, deviceProfiles, measurements, thresholdOf],
  );
  const draftRating = useMemo(
    () => (offerNoiseProfiles && shownDraft ? rateNoiseProfile(measurements, noiseMaskOf(shownDraft), thresholdOf) : null),
    [offerNoiseProfiles, shownDraft, measurements, thresholdOf],
  );

  /** POST noise-profiles/<path>/ - then the profiles and the heatmap load again. */
  const noiseRequest = (path: string, data: object, done?: (response: { data?: { profile?: NoiseProfile } }) => void) => {
    setNoiseBusy(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/noise-profiles/${path}/`,
      data,
      (response) => {
        setNoiseBusy(false);
        heatmapCache.current.clear();
        setNoiseRevision((revision) => revision + 1);
        loadNoiseProfiles();
        done?.(response);
      },
      (error) => {
        setNoiseBusy(false);
        showRequestError(enqueueSnackbar, t('noise_profile_error'), error);
      },
    );
  };

  // A new draft: per sensor the minimum EP / WP of every measurement (not
  // only the loaded ones) of the selected span.
  const createNoiseProfile = () => {
    if (shownDevice == null || !profileRange) {
      return;
    }
    const iso = (ms: number) => encodeURIComponent(new Date(ms).toISOString());
    setNoiseBusy(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/noise-profiles/suggest/?device=${shownDevice}&from=${iso(profileRange.from)}&to=${iso(profileRange.to)}`,
      (response) => {
        setNoiseBusy(false);
        const data = response?.data ?? {};
        setDraft({
          id: null,
          device: shownDevice,
          // With the span it was made from: "Profil 06.11.2026 · 7 Tage, 5 Std."
          name: t('noise_profile_default_name', {
            date: new Date().toLocaleDateString(),
            span: spanParts(profileRange.to - profileRange.from)
              .map(({ unit, count }) => t(`span_${unit}`, { count }))
              .join(', '),
          }),
          mask_e: (data.mask_e || []) as number[],
          mask_w: (data.mask_w || []) as number[],
          source_from: data.source_from ?? null,
          source_to: data.source_to ?? null,
          source_count: Number(data.source_count ?? 0),
        });
        setDraftPreview(true);
      },
      (error) => {
        setNoiseBusy(false);
        showRequestError(enqueueSnackbar, t('noise_profile_error'), error);
      },
    );
  };

  const editNoiseProfile = (profile: NoiseProfile) => {
    setDraft({
      id: profile.id,
      device: profile.device,
      name: profile.name,
      mask_e: [...profile.mask_e],
      mask_w: [...profile.mask_w],
      source_from: profile.source_from,
      source_to: profile.source_to,
      source_count: profile.source_count,
    });
    setDraftPreview(true);
  };

  const saveNoiseProfile = () => {
    if (!draft) {
      return;
    }
    noiseRequest('save', { ...draft, name: draft.name.trim() }, (response) => {
      setDraft(null);
      setSelectedProfileId(response?.data?.profile?.id ?? null);
      enqueueSnackbar(t('noise_profile_saved'), { variant: 'success' });
    });
  };

  const downloadNoiseProfile = (profile: NoiseProfile) =>
    downloadBlob(
      new Blob([noiseProfileCsv(profile)], { type: 'text/csv' }),
      `${location?.project_id ?? locationId}-stoerungsprofil-${profile.id}.csv`,
    );

  // The raw measurement of the slider's frame - faint lines in the profile plot.
  const referenceSamples = useMemo(() => {
    if (!shownDraft || !measurements.length) {
      return null;
    }
    // The one nearest to the frame - no frame picked: the newest one.
    const rank = (ms: number) => (frameTime == null ? -ms : Math.abs(ms - frameTime));
    let samples: number[] = [];
    let best = Number.POSITIVE_INFINITY;
    for (const row of measurements) {
      const ms = parseTimestamp(row.last_fetched);
      if (ms != null && Array.isArray(row.samples) && rank(ms) < best) {
        samples = row.samples;
        best = rank(ms);
      }
    }
    return {
      ep: samples.filter((_, index) => index % 2 === 0).map(Number),
      wp: samples.filter((_, index) => index % 2 === 1).map(Number),
    };
  }, [shownDraft, measurements, frameTime]);

  // Thresholds saved in the panel: the heatmap brings the new ones (and the
  // ratings count against them).
  const onThresholdsSaved = useCallback(() => {
    heatmapCache.current.clear();
    setNoiseRevision((revision) => revision + 1);
  }, []);

  const noisePanel = offerNoiseProfiles ? (
    <NoiseProfilePanel
      deviceName={devices.find((device) => device.id === shownDevice)?.display_name ?? null}
      profiles={deviceProfiles}
      ratings={noiseRatings}
      selectedId={selectedProfile?.id ?? null}
      onSelect={setSelectedProfileId}
      testedId={testedProfile?.id ?? null}
      onTest={setTestedProfileId}
      view={noiseView}
      busy={noiseBusy}
      range={profileRange}
      onClearRange={() => setProfileRange(null)}
      onPickRange={setProfileRange}
      onCreate={createNoiseProfile}
      onEdit={editNoiseProfile}
      onActivate={(profile) =>
        noiseRequest('activate', { id: profile.id }, () => {
          setTestedProfileId(null);
          enqueueSnackbar(t('noise_profile_activated', { name: profile.name }), { variant: 'success' });
        })
      }
      onDeactivate={() =>
        noiseRequest('deactivate', { device: shownDevice }, () =>
          enqueueSnackbar(t('noise_profile_deactivated'), { variant: 'success' }),
        )
      }
      onDelete={(profile) =>
        noiseRequest('delete', { id: profile.id }, () => {
          setSelectedProfileId((id) => (id === profile.id ? null : id));
          setTestedProfileId((id) => (id === profile.id ? null : id));
        })
      }
      onDownload={downloadNoiseProfile}
      draftName={shownDraft ? shownDraft.name : null}
      draftRating={draftRating}
      editor={
        shownDraft ? (
          <NoiseProfileEditor
            draft={shownDraft}
            onChange={setDraft}
            onSave={saveNoiseProfile}
            onCancel={() => setDraft(null)}
            saving={noiseBusy}
            preview={draftPreview}
            onPreviewChange={setDraftPreview}
            reference={referenceSamples}
          />
        ) : null
      }
      thresholds={
        <ThresholdMixerToggle
          locationId={locationId}
          initialObjectThreshold={alarmThreshold}
          onSaved={onThresholdsSaved}
        />
      }
    />
  ) : null;

  // An area dragged on the plan: its sensors (of the shown device, else of
  // the first other one - shown then) become the second plot's selection.
  const selectPlanArea = (positions: number[]) => {
    const picked = positions.map((pos) => {
      const point = heatmap?.sensor_points?.find((candidate) => candidate.pos === pos);
      return { device: point?.device ?? null, pair: (point?.pair ?? pos) - 1 };
    });
    const pairsOf = (entries: typeof picked) => [...new Set(entries.map((entry) => entry.pair))].sort((a, b) => a - b);
    const ofShown = picked.filter((entry) => entry.device == null || entry.device === shownDevice);
    if (ofShown.length) {
      setSensors(pairsOf(ofShown));
      return;
    }
    const other = picked.find((entry) => devices.some((candidate) => candidate.id === entry.device));
    if (other?.device != null) {
      setPickedDevice({ locationId, id: other.device });
      setSensors(pairsOf(picked.filter((entry) => entry.device === other.device)));
    }
  };

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
  // (LoRaWAN: only the period).
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
          <PillSelect
            label={t('analyse_compare')}
            title={compareOptions.length ? t('analyse_compare_hint') : t('analyse_compare_unavailable')}
            options={[
              { value: '', label: t('analyse_compare_none') },
              ...compareOptions.map((offset) => ({
                value: String(offset.days),
                label: t(`analyse_compare_${offset.key}`),
              })),
            ]}
            value={compare ? String(compare.days) : ''}
            onChange={(value) => setCompareDays(value ? Number(value) : null)}
          />
          {compare && (
            <Button
              size="sm"
              variant="outline-secondary"
              className="d-inline-flex align-items-center gap-1 py-0"
              style={{ fontSize: 12, borderRadius: 'var(--progeo-radius-pill)' }}
              onClick={() => setCompareDays(null)}
            >
              <XLg size={11} />
              {t('analyse_compare_end')}
            </Button>
          )}
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
        {offerNoiseProfiles && (
          <button
            type="button"
            className="btn btn-outline-secondary btn-sm"
            title={t('analyse_export_csv_raw_hint')}
            onClick={() => {
              void openResponseInNewTab(auth, `/v1/location/${locationId}/export_csv/?raw=1`);
              setExportMsg(t('analyse_export_csv_done'));
            }}
          >
            {t('analyse_export_csv_raw')}
          </button>
        )}
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

      {/* One slider for the heatmap and the charts (also LoRaWAN's), with
          the period it covers - kept on top while the page scrolls down. */}
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
            visibleRange={isLorawan ? null : chartZoom}
            toolbar={rangeControl}
            selection={offerNoiseProfiles ? profileRange : null}
            onSelectionChange={offerNoiseProfiles ? setProfileRange : undefined}
            selectionLabel={t('noise_profile_range_band')}
          />
        ) : (
          <div className="d-flex flex-wrap align-items-center gap-2 py-3">{rangeControl}</div>
        )}
        {/* The keys the page reacts to - a processed press lights its chip. */}
        {frameSeconds.length > 0 && (
          <KeyHints title={t('key_hints_title')} hints={pageKeyHints} className="pb-2" />
        )}
      </div>

      {isLorawan ? (
        <>
          <LocationClimateHeatmap
            locationId={locationId}
            range={range}
            hoveredDeviceId={hoveredDeviceId}
            onHoverDevice={setHoveredDeviceId}
            time={frameTime}
            onTimeChange={setFrameTime}
            onFramesChange={setClimateHeatmapFrames}
          />
          <LocationClimatePanels
            locationId={locationId}
            range={range}
            showBattery={isStaff}
            hoveredDeviceId={hoveredDeviceId}
            onHoverDevice={setHoveredDeviceId}
            frameTime={frameSeconds.length ? frameSeconds[frameIndex] * 1000 : null}
            onFramesChange={setClimateChartFrames}
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
              {compare && (
                <span className="ms-2 small text-muted">{t('analyse_heatmap_change', { label: compareLabel })}</span>
              )}
              <PlotHelp topic="heatmap" className="ms-2 align-middle" />
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
                  ) : (
                    // smartex® dm too: the heat field with its band lines.
                    <SensorHeatmap2D
                      response={changeHeatmap ?? shownHeatmap}
                      heatTitle={changeHeatmap ? t('heatmap_change') : undefined}
                      forceNormalize={changeHeatmap != null}
                      onAreaSelect={selectPlanArea}
                      selectedPositions={selectedPositions}
                      fitPlan
                      hideChrome
                      time={frameTime}
                      onTimeChange={setFrameTime}
                      hideFrameSlider
                      onSensorClick={selectPlanSensor}
                      profile={heatProfile}
                      onProfileChange={setHeatProfile}
                      profileLoading={heatmapLoading}
                    />
                  )}
                </Card.Body>
              </div>
            </Collapse>
          </Card>

          {compare && (
            <MeasurementComparePlot
              rows={shownMeasurements}
              pastRows={compareRowsShown ?? []}
              time={frameTime}
              offsetMs={compareOffsetMs}
              label={compareLabel}
              loading={compareLoading}
              onClose={() => setCompareDays(null)}
              selectedSensors={sensors}
              onSensorSelect={(sensor) => setSensors((selected) => toggledSensor(selected, sensor))}
            />
          )}

          {noisePanel}

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
                  threshold={alarmThreshold}
                  sensorThresholds={sensorThresholds}
                  maskLines={maskLines}
                  selectedRange={offerNoiseProfiles ? profileRange : null}
                  onRangeSelect={offerNoiseProfiles ? setProfileRange : null}
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
