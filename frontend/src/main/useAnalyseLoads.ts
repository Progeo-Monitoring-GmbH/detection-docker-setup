import { useCallback, useEffect, useRef, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import {
  type HeatProfile,
  heatProfileQuery,
  type SensorHeatmapResponse,
} from '../components/device/sensorHeatmapTypes';
import type { MeasurementCompareRow } from '../components/device/MeasurementSamplesCompareChart.tsx';
import { TIME_RANGE_DAYS } from './timeRanges';
import {
  cutHeatmap,
  cutMeasurements,
  type MeasurementsLoad,
} from './analyseCache';
import {
  deviceQuery,
  heatmapComplete,
  type LoadCache,
  measurementRowsOf,
  measurementsLoadOf,
  recallLoad,
  rememberLoad,
} from './analyseLoads';

/** Staff: the selected sensors' history (second plot) - the last 3 months,
 * in as many measurements as the backend gives (its limit). */
export const SENSOR_HISTORY_DAYS = TIME_RANGE_DAYS['90d'];
const MAX_HISTORY_MEASUREMENTS = 2000;

export type AnalyseDevice = { id: number; display_name: string };

type HeatmapOptions = {
  locationId: number;
  /** smartex io objects have no heatmap of their own. */
  enabled: boolean;
  days: number;
  resolution: number;
  planQuery: string;
  heatProfile: HeatProfile;
  /** The backend cleans the heatmap (useNoiseProfileState.ts). */
  heatNoiseQuery: string;
  /** Bumped when a profile / threshold / sensor changed - load again. */
  revision: number;
};

/**
 * The location heatmap of the period. Loads by period are kept - switching
 * back, or to a shorter period inside a complete longer load, needs no
 * request (analyseCache). Only the newest request may set the data -
 * switching periods quickly must not let a slower, older response win.
 */
export const useAnalyseHeatmap = ({
  locationId,
  enabled,
  days,
  resolution,
  planQuery,
  heatProfile,
  heatNoiseQuery,
  revision,
}: HeatmapOptions) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [heatmap, setHeatmap] = useState<SensorHeatmapResponse | null>(null);
  const [heatmapLoading, setHeatmapLoading] = useState(true);
  const request = useRef(0);
  const cache = useRef<LoadCache<SensorHeatmapResponse>>(new Map());

  const loadHeatmap = useCallback(() => {
    if (!enabled) {
      return;
    }
    const cacheKey = `${locationId}:${planQuery}:${heatProfile}:${heatNoiseQuery}`;
    const cached = recallLoad(
      cache.current,
      cacheKey,
      days,
      resolution,
      (value, fromMs) => cutHeatmap(value, fromMs) ?? value,
    );
    const current = ++request.current;
    if (cached) {
      setHeatmap(cached);
      setHeatmapLoading(false);
      return;
    }
    setHeatmapLoading(true);
    const isCurrent = () => current === request.current;
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/heatmap/?days=${days}&limit=${resolution}${planQuery}${heatProfileQuery(heatProfile)}${heatNoiseQuery}`,
      (response) => {
        const data = (response?.data || null) as SensorHeatmapResponse | null;
        if (data) {
          rememberLoad(cache.current, cacheKey, {
            days,
            limit: resolution,
            complete: heatmapComplete(data),
            value: data,
          });
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
    // revision: a changed profile - the cache was cleared, load again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    auth,
    days,
    enabled,
    enqueueSnackbar,
    heatProfile,
    heatNoiseQuery,
    locationId,
    revision,
    planQuery,
    resolution,
  ]);

  useEffect(() => {
    loadHeatmap();
  }, [loadHeatmap]);

  const clearHeatmapCache = useCallback(() => cache.current.clear(), []);

  return { heatmap, heatmapLoading, loadHeatmap, clearHeatmapCache };
};

type MeasurementsOptions = {
  locationId: number;
  /** smartex io objects have their climate charts instead. */
  enabled: boolean;
  days: number;
  resolution: number;
  /** The picked device; null: the backend's default (measured last). */
  deviceId: number | null;
  /** Staff: `&raw=1` - cleaned here (noiseProfiles.ts). */
  rawQuery: string;
};

/**
 * The measurements of one device over the period, with the location's
 * devices and the one shown - kept by period like the heatmap. Switching
 * the device reloads only these.
 */
export const useAnalyseMeasurements = ({
  locationId,
  enabled,
  days,
  resolution,
  deviceId,
  rawQuery,
}: MeasurementsOptions) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [load, setLoad] = useState<MeasurementsLoad>({
    rows: [],
    total: 0,
    devices: [],
    device: null,
  });
  const [measurementsLoading, setMeasurementsLoading] = useState(true);
  const request = useRef(0);
  const cache = useRef<LoadCache<MeasurementsLoad>>(new Map());

  const loadMeasurements = useCallback(() => {
    if (!enabled) {
      return;
    }
    const show = (next: MeasurementsLoad) => {
      setLoad(next);
      setMeasurementsLoading(false);
    };
    const cacheKey = `${locationId}:${deviceId ?? 'default'}`;
    const cached = recallLoad(
      cache.current,
      cacheKey,
      days,
      resolution,
      cutMeasurements,
    );
    const current = ++request.current;
    if (cached) {
      show(cached);
      return;
    }
    setMeasurementsLoading(true);
    const isCurrent = () => current === request.current;
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/measurements/?days=${days}&limit=${resolution}${deviceQuery(deviceId)}${rawQuery}`,
      (response) => {
        const loaded = measurementsLoadOf(response?.data);
        rememberLoad(cache.current, cacheKey, {
          days,
          limit: resolution,
          complete: loaded.total <= loaded.rows.length,
          value: loaded,
        });
        if (isCurrent()) {
          show(loaded);
        }
      },
      (error) => {
        if (isCurrent()) {
          showRequestError(
            enqueueSnackbar,
            'Could not load measurements',
            error,
          );
          setMeasurementsLoading(false);
        }
      },
    );
  }, [
    auth,
    days,
    deviceId,
    enabled,
    enqueueSnackbar,
    locationId,
    rawQuery,
    resolution,
  ]);

  useEffect(() => {
    loadMeasurements();
  }, [loadMeasurements]);

  const clearMeasurementsCache = useCallback(() => cache.current.clear(), []);

  return {
    measurements: load.rows,
    measurementTotal: load.total,
    devices: load.devices as AnalyseDevice[],
    shownDevice: load.device,
    shownDeviceName:
      load.devices.find((device) => device.id === load.device)?.display_name ??
      null,
    measurementsLoading,
    loadMeasurements,
    clearMeasurementsCache,
  };
};

/**
 * Staff: the shown device's last 3 months for the second plot - by location
 * and device, so another one's history is never shown.
 */
export const useSensorHistory = ({
  locationId,
  shownDevice,
  rawQuery,
}: {
  locationId: number;
  shownDevice: number | null;
  rawQuery: string;
}) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [history, setHistory] = useState<{
    key: string;
    rows: MeasurementCompareRow[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const key = `${locationId}:${shownDevice}`;
  const rows = history?.key === key ? history.rows : null;

  const toggle = () => {
    if (rows) {
      setHistory(null);
      return;
    }
    setLoading(true);
    const current = ++request.current;
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/measurements/?days=${SENSOR_HISTORY_DAYS}&limit=${MAX_HISTORY_MEASUREMENTS}${deviceQuery(shownDevice)}${rawQuery}`,
      (response) => {
        if (current === request.current) {
          setHistory({ key, rows: measurementRowsOf(response?.data) });
          setLoading(false);
        }
      },
      (error) => {
        if (current === request.current) {
          showRequestError(
            enqueueSnackbar,
            'Could not load the sensor history',
            error,
          );
          setLoading(false);
        }
      },
    );
  };

  const clear = useCallback(() => setHistory(null), []);

  return { rows, loading, toggle, clear };
};
