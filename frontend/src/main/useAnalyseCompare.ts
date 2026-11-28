import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import {
  type AuthContextType,
  useAuth,
} from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import {
  type HeatProfile,
  heatProfileQuery,
  type SensorHeatmapResponse,
} from '../components/device/sensorHeatmapTypes';
import type { MeasurementCompareRow } from '../components/device/MeasurementSamplesCompareChart.tsx';
import {
  type CompareOffset,
  compareOffsetsFor,
  heatmapChange,
} from './analyseCompare';
import { smoothHeatmap, smoothMeasurements } from './analyseSmoothing';
import { cleanRows, type NoiseMask } from './noiseProfiles';
import { deviceQuery, measurementRowsOf } from './analyseLoads';
import {
  combinedRows,
  type DeviceLoad,
  type DeviceSpan,
} from './analyseDevices';
import { useLatestRef } from '../components/ui/useLatestRef';
import type { MeasurementRange } from './timeRanges';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A load for the settings (`key`) it was loaded with. */
type Keyed<T> = { key: string; value: T };

/** The value of `state` while it is for `key`, else null. */
const keyedValue = <T>(state: Keyed<T> | null, key: string | null) =>
  state && state.key === key ? state.value : null;

type CompareQuery = {
  locationId: number;
  days: number;
  resolution: number;
  heatProfile: HeatProfile;
  shownDevice: number | null;
  heatNoiseQuery: string;
  planQuery: string;
  rawQuery: string;
  /** All devices (analyseDevices.ts): their past rows put together like
   * the shown ones; null: the shown device's. */
  layout?: DeviceSpan[] | null;
};

/** The heatmap and measurement URLs of the same period, ending `offsetDays` ago. */
export const compareUrls = (
  query: CompareQuery,
  offsetDays: number,
  now: number,
) => {
  const to = encodeURIComponent(
    new Date(now - offsetDays * DAY_MS).toISOString(),
  );
  const period = `days=${query.days}&limit=${query.resolution}&to=${to}`;
  const base = `/v1/location/${query.locationId}`;
  return {
    heatmap: `${base}/heatmap/?${period}${query.planQuery}${heatProfileQuery(query.heatProfile)}${query.heatNoiseQuery}`,
    measurements: `${base}/measurements/?${period}${deviceQuery(query.shownDevice)}${query.rawQuery}`,
  };
};

/** GET `url` - only while `isCurrent`, the data or (an error) the fallback. */
const fetchCurrent = <T>(
  auth: AuthContextType,
  url: string,
  isCurrent: () => boolean,
  read: (data: unknown) => T,
  fallback: T,
  done: (value: T) => void,
  failed: (error: unknown) => void,
) =>
  void axiosConfig.perform_get(
    auth,
    url,
    (response) => {
      if (isCurrent()) {
        done(read(response?.data));
      }
    },
    (error) => {
      if (isCurrent()) {
        failed(error);
        done(fallback);
      }
    },
  );

const heatmapOf = (data: unknown) =>
  (data || null) as SensorHeatmapResponse | null;

const rowsOf = (data: unknown) =>
  measurementRowsOf(data as Parameters<typeof measurementRowsOf>[0]);

/** GET the rows of each device's `url` - put together by `layout`. */
const fetchCombined = (
  auth: AuthContextType,
  url: (device: number) => string,
  layout: DeviceSpan[],
) =>
  Promise.all(
    layout.map(
      (span) =>
        new Promise<DeviceLoad>((resolve, reject) =>
          void axiosConfig.perform_get(
            auth,
            url(span.device),
            (response) => {
              const rows = rowsOf(response?.data);
              resolve({ ...span, rows, total: rows.length, offline: [] });
            },
            reject,
          ),
        ),
    ),
  ).then((loads) => combinedRows(loads, layout));

/**
 * The comparison's heatmap and measurements for `compare` (none: nothing
 * loads), by the settings they were loaded with; only the newest request
 * may set them.
 */
const useCompareLoads = (
  query: CompareQuery & { enabled: boolean; revision: number },
  compare: CompareOffset | null,
) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [heatmap, setHeatmap] =
    useState<Keyed<SensorHeatmapResponse | null> | null>(null);
  const [rows, setRows] = useState<Keyed<MeasurementCompareRow[]> | null>(null);
  const request = useRef(0);
  const { layout } = query;
  const layoutKey = layout
    ? layout.map((span) => `${span.device}+${span.pairs}`).join(',')
    : '';
  const key = compare
    ? `${query.locationId}:${compare.days}:${query.days}:${query.resolution}:${query.heatProfile}:${query.shownDevice}:${query.heatNoiseQuery}:${query.revision}:${query.planQuery}:${layoutKey}`
    : null;
  const { enabled, locationId, days, resolution, heatProfile } = query;
  const { shownDevice, heatNoiseQuery, planQuery, rawQuery } = query;
  const layoutRef = useLatestRef(layout ?? null);

  const loadCompare = useCallback(() => {
    if (!compare || !key || !enabled) {
      return;
    }
    const current = ++request.current;
    const isCurrent = () => current === request.current;
    const failed = (error: unknown) =>
      showRequestError(enqueueSnackbar, 'Could not load the comparison', error);
    const now = Date.now();
    const compareQuery = {
      locationId,
      days,
      resolution,
      heatProfile,
      shownDevice,
      heatNoiseQuery,
      planQuery,
      rawQuery,
      layout: null,
    };
    const urls = compareUrls(compareQuery, compare.days, now);
    fetchCurrent(
      auth,
      urls.heatmap,
      isCurrent,
      heatmapOf,
      null,
      (value) => setHeatmap({ key, value }),
      failed,
    );
    const combineBy = layoutRef.current;
    if (combineBy) {
      // Every device's, cleaned by the backend like the shown ones.
      const deviceUrl = (device: number) =>
        compareUrls(
          { ...compareQuery, shownDevice: device, rawQuery: '' },
          compare.days,
          now,
        ).measurements;
      fetchCombined(auth, deviceUrl, combineBy)
        .then((value) => {
          if (isCurrent()) {
            setRows({ key, value });
          }
        })
        .catch((error: unknown) => {
          if (isCurrent()) {
            failed(error);
            setRows({ key, value: [] });
          }
        });
      return;
    }
    fetchCurrent(
      auth,
      urls.measurements,
      isCurrent,
      rowsOf,
      [],
      (value) => setRows({ key, value }),
      failed,
    );
  }, [
    auth,
    compare,
    key,
    days,
    enabled,
    enqueueSnackbar,
    heatNoiseQuery,
    heatProfile,
    locationId,
    planQuery,
    rawQuery,
    resolution,
    shownDevice,
    layoutRef,
  ]);

  useEffect(() => {
    loadCompare();
  }, [loadCompare]);

  return {
    key,
    pastHeatmap: keyedValue(heatmap, key),
    pastRows: keyedValue(rows, key),
    loading: key != null && (heatmap?.key !== key || rows?.key !== key),
    loadCompare,
  };
};

type CompareOptions = CompareQuery & {
  /** smartex io objects compare nothing. */
  enabled: boolean;
  /** The location's measured span - offsets reach back to its oldest one. */
  measurementRange: MeasurementRange | null;
  revision: number;
  /** Cleaned and smoothed like the shown measurements / heatmap. */
  displayMask: NoiseMask | null;
  meanWindow: number;
  shownHeatmap: SensorHeatmapResponse | null;
};

/**
 * The comparison with the past: the same period this many days earlier
 * (null: none) - offered only as far back as the data reaches. Its heatmap
 * shows every sensor's change since then, its measurements a plot of their own.
 */
const useAnalyseCompare = ({
  measurementRange,
  displayMask,
  meanWindow,
  shownHeatmap,
  ...query
}: CompareOptions) => {
  const { t } = useTranslation();
  const [compareDays, setCompareDays] = useState<number | null>(null);
  const [openedAt] = useState(() => Date.now());
  const compareOptions = useMemo(
    () => compareOffsetsFor(measurementRange?.first, query.days, openedAt),
    [measurementRange, query.days, openedAt],
  );
  const compare =
    compareOptions.find((offset) => offset.days === compareDays) ?? null;
  const compareOffsetMs = compare ? compare.days * DAY_MS : 0;
  const loads = useCompareLoads(query, compare);
  const { pastHeatmap, pastRows } = loads;

  const compareRowsShown = useMemo(
    () =>
      pastRows
        ? smoothMeasurements(cleanRows(pastRows, displayMask), meanWindow)
        : null,
    [pastRows, displayMask, meanWindow],
  );
  // The heatmap while comparing: every sensor's change since then.
  const changeHeatmap = useMemo(
    () =>
      compare && pastHeatmap
        ? heatmapChange(
            shownHeatmap,
            smoothHeatmap(pastHeatmap, meanWindow),
            compareOffsetMs,
          )
        : null,
    [compare, pastHeatmap, shownHeatmap, meanWindow, compareOffsetMs],
  );

  return {
    compareOptions,
    compare,
    setCompareDays,
    compareOffsetMs,
    compareRowsShown,
    compareLoading: loads.loading,
    changeHeatmap,
    compareLabel: compare ? t(`analyse_compare_${compare.key}`) : '',
    loadCompare: loads.loadCompare,
  };
};

export default useAnalyseCompare;
