import { useCallback, useEffect, useRef, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { useLatestRef } from '../components/ui/useLatestRef';
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
import { combinedLoad, type DeviceSpan } from './analyseDevices';
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
  /** Every device of the location at once (analyseDevices.ts) - once
   * there is more than one; the picked device is kept for later. */
  allDevices: boolean;
  /** Staff: `&raw=1` - cleaned here (noiseProfiles.ts). */
  rawQuery: string;
};

type ShownLoad = MeasurementsLoad & {
  /** All devices: where each one's pairs sit; null: one device. */
  layout: DeviceSpan[] | null;
};

const EMPTY_LOAD: ShownLoad = {
  rows: [],
  total: 0,
  devices: [],
  device: null,
  offline: [],
  layout: null,
};

/**
 * The measurements of one device over the period, with the location's
 * devices and the one shown - kept by period and device like the heatmap.
 * Switching the device reloads only these. `allDevices`: every device's,
 * one request each (from the same cache), as one set of rows.
 */
export const useAnalyseMeasurements = ({
  locationId,
  enabled,
  days,
  resolution,
  deviceId,
  allDevices,
  rawQuery,
}: MeasurementsOptions) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [load, setLoad] = useState<ShownLoad>(EMPTY_LOAD);
  const [measurementsLoading, setMeasurementsLoading] = useState(true);
  const request = useRef(0);
  const cache = useRef<LoadCache<MeasurementsLoad>>(new Map());
  // The devices to combine - known from the load before (the button is
  // offered only then). A key, so a new load of them doesn't load again.
  const devicesKey = load.devices.map((device) => device.id).join(',');
  const combineKey = allDevices && load.devices.length > 1 ? devicesKey : '';
  const devicesRef = useLatestRef(load.devices);

  // One device's load: from the cache (at once), else requested.
  const deviceLoad = useCallback(
    (
      device: number | null,
      query: string,
      done: (load: MeasurementsLoad) => void,
      failed: (error: unknown) => void,
    ) => {
      const cacheKey = `${locationId}:${device ?? 'default'}:${query}`;
      const cached = recallLoad(
        cache.current,
        cacheKey,
        days,
        resolution,
        cutMeasurements,
      );
      if (cached) {
        done(cached);
        return;
      }
      void axiosConfig.perform_get(
        auth,
        `/v1/location/${locationId}/measurements/?days=${days}&limit=${resolution}${deviceQuery(device)}${query}`,
        (response) => {
          const loaded = measurementsLoadOf(response?.data);
          rememberLoad(cache.current, cacheKey, {
            days,
            limit: resolution,
            complete: loaded.total <= loaded.rows.length,
            value: loaded,
          });
          done(loaded);
        },
        failed,
      );
    },
    [auth, days, locationId, resolution],
  );

  const loadMeasurements = useCallback(() => {
    if (!enabled) {
      return;
    }
    const current = ++request.current;
    const isCurrent = () => current === request.current;
    let settled = false;
    const failed = (error: unknown) => {
      if (isCurrent() && !settled) {
        settled = true;
        showRequestError(enqueueSnackbar, 'Could not load measurements', error);
        setMeasurementsLoading(false);
      }
    };
    const show = (next: ShownLoad) => {
      if (isCurrent()) {
        settled = true;
        setLoad(next);
        setMeasurementsLoading(false);
      }
    };
    if (!combineKey) {
      deviceLoad(
        deviceId,
        rawQuery,
        (loaded) => show({ ...loaded, layout: null }),
        failed,
      );
    } else {
      // Every device's, cleaned by the backend (its active profiles) - a
      // staff's draft or tried-out profile is one device's.
      const devices = devicesRef.current;
      const loads: (MeasurementsLoad | null)[] = devices.map(() => null);
      let missing = devices.length;
      devices.forEach((device, index) =>
        deviceLoad(
          device.id,
          '',
          (loaded) => {
            loads[index] = loaded;
            missing -= 1;
            if (missing > 0) {
              return;
            }
            const combined = combinedLoad(
              devices.map((entry, slot) => ({
                device: entry.id,
                name: entry.display_name,
                rows: loads[slot]?.rows ?? [],
                total: loads[slot]?.total ?? 0,
                offline: loads[slot]?.offline ?? [],
              })),
            );
            show({ ...combined, devices, device: null });
          },
          failed,
        ),
      );
    }
    // Still waiting for a response (not all from the cache).
    if (!settled && isCurrent()) {
      setMeasurementsLoading(true);
    }
  }, [
    enabled,
    enqueueSnackbar,
    combineKey,
    devicesRef,
    deviceLoad,
    deviceId,
    rawQuery,
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
    /** All devices: where each one's pairs sit (analyseDevices.ts). */
    layout: load.layout,
    /** Spans without a measurement for over 24 h (all devices: of any). */
    offline: load.offline,
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
