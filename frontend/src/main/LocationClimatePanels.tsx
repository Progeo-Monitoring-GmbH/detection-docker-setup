import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { downloadBlob } from '../download';
import { showErrorBar, showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PillButton from '../components/ui/kit/PillButton';
import DeviceRenameModal from '../components/modal/DeviceRenameModal';
import ClimateChart, {
  type ClimateMetric,
  type ClimateResponse,
} from '../components/device/ClimateChart';
import PanelCard from '../components/ui/kit/PanelCard';
import PlotHelp from '../components/ui/PlotHelp';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import {
  availableTimeRanges,
  bucketLabel,
  effectiveTimeRange,
  TIME_RANGE_DAYS,
  timeRangeCandidates,
  timeRangeLabelKey,
  type TimeRange,
} from './timeRanges';
import useMeasurementRange from './useMeasurementRange';
import { staffFlags } from './access';
import { childTestId } from '../testIds';
import './LocationClimatePanels.css';

type LocationClimatePanelsProps = {
  locationId: number;
  /** Public demo view: read the series from /v1/demo/. */
  demo?: boolean;
  /** The battery chart - LocationStatusView shows it to staff only. */
  showBattery?: boolean;
  /** The device highlighted in every chart - pass both to share it (e.g.
   * with the climate heatmap); without, the panels keep their own. */
  hoveredDeviceId?: number | null;
  onHoverDevice?: (deviceId: number | null) => void;
  /** The range, picked by the parent (Analyse tab: one toggle for the
   * heatmap and the charts) - without, the panels offer their own toggle. */
  range?: TimeRange;
  /** The page's frame slider (epoch ms): a line on every chart. */
  frameTime?: number | null;
  /** Reports the times (Unix seconds, oldest first) of all readings - the
   * page's slider runs over them when there is no heatmap. */
  onFramesChange?: (timestamps: number[]) => void;
  /** data-testid of the panels (default "climate-panels"); their parts derive from it. */
  testId?: string;
};

/**
 * LoRaWAN objects (ProgeoLocation.PROJECT_TYPE_CHOICES.LORAWAN): no samples,
 * so no heatmap - instead humidity, temperature and battery per device, from
 * GET /v1/location/<pk>/climate/.
 */
const LocationClimatePanels = ({
  locationId,
  demo = false,
  showBattery = true,
  hoveredDeviceId: controlledHoveredDevice,
  onHoverDevice,
  range: controlledRange,
  frameTime = null,
  onFramesChange,
  testId = 'climate-panels',
}: LocationClimatePanelsProps) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const flags = staffFlags(auth?.user);
  const isStaff = !demo && flags.isStaffOrSuperuser;

  // Only ranges the data reaches into; an unavailable selection falls back
  // to the longest offered range.
  const measurementRange = useMeasurementRange(locationId, demo, controlledRange == null);
  const availableRanges = useMemo(
    () => availableTimeRanges(measurementRange, timeRangeCandidates({ long: true, staff: isStaff })),
    [isStaff, measurementRange],
  );
  const [selectedRange, setSelectedRange] = useState<TimeRange>('7d');
  const range = controlledRange ?? effectiveTimeRange(selectedRange, availableRanges);
  const [climate, setClimate] = useState<ClimateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [ownHoveredDevice, setOwnHoveredDevice] = useState<number | null>(null);
  const hoveredDeviceId = onHoverDevice ? (controlledHoveredDevice ?? null) : ownHoveredDevice;
  const setHoveredDeviceId = onHoverDevice ?? setOwnHoveredDevice;
  // Reference time of the comparison tooltips (a clicked point) - shared by
  // every chart, so humidity and temperature compare against the same moment.
  // Kept per range - another range (also the parent's) drops it.
  const [reference, setReference] = useState<{ range: TimeRange; time: number } | null>(null);
  const referenceTime = reference?.range === range ? reference.time : null;
  const setReferenceTime = useCallback(
    (time: number | null) => setReference(time == null ? null : { range, time }),
    [range],
  );
  const importInputRef = useRef<HTMLInputElement>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  // Only the latest request may land - a slow (long-range, aggregated)
  // response must not overwrite the range picked after it.
  const latestRequest = useRef(0);

  const loadClimate = useCallback(() => {
    const request = ++latestRequest.current;
    setLoading(true);
    setDenied(false);
    void axiosConfig.perform_get(
      auth,
      `${demo ? '/v1/demo' : '/v1/location'}/${locationId}/climate/?days=${TIME_RANGE_DAYS[range]}`,
      (response) => {
        if (request !== latestRequest.current) {
          return;
        }
        setClimate((response?.data || null) as ClimateResponse | null);
        setLoading(false);
      },
      (error) => {
        if (request !== latestRequest.current) {
          return;
        }
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
  const frames = useMemo(
    () => [...new Set((climate?.devices ?? []).flatMap((device) => device.timestamps))].sort((a, b) => a - b),
    [climate],
  );
  useEffect(() => {
    onFramesChange?.(frames);
  }, [frames, onFramesChange]);
  // Long ranges come back averaged per bucket (null/absent for raw data).
  const bucketSeconds = climate?.bucket_seconds ?? null;
  const bucket = bucketLabel(bucketSeconds);

  const isSuperuser = !demo && flags.isSuperuser;
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
        downloadBlob(
          new Blob([response.data], { type: 'application/json' }),
          `measurements_location_${locationId}.json`,
        );
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

  const body = (metric: ClimateMetric, axisTitle: string, unit: string) =>
    denied ? (
      <div className="climate-muted climate-muted--large" data-testid={childTestId(testId, metric, 'denied')}>
        {t('status_no_measurement_access')}
      </div>
    ) : loading && !climate ? (
      <div className="d-flex justify-content-center py-5 text-muted" data-testid={childTestId(testId, metric, 'loading')}>
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
        bucketSeconds={bucketSeconds}
        referenceTime={referenceTime}
        onReferenceChange={setReferenceTime}
        frameTime={frameTime}
        rainEvents={climate?.rain_events}
      />
    );

  return (
    <div className="climate-panels" data-testid={testId}>
      {(controlledRange == null || bucket || isSuperuser) && (
        <div className="climate-toolbar" data-testid={childTestId(testId, 'toolbar')}>
          {controlledRange == null && (
            <SegmentedControl
              testId={childTestId(testId, 'range')}
              options={availableRanges.map((value) => ({
                value,
                label: t(timeRangeLabelKey(value)),
              }))}
              value={range}
              onChange={(value) => setSelectedRange(value as TimeRange)}
            />
          )}
          {bucket && (
            <span className="climate-muted" data-testid={childTestId(testId, 'bucket')}>
              {t(bucket.key, { count: bucket.count })}
            </span>
          )}
          {isSuperuser && (
            <div className="climate-tools" data-testid={childTestId(testId, 'tools')}>
              <PillButton
                testId={childTestId(testId, 'rename-devices')}
                variant="ghost"
                label={t('device_rename_title')}
                disabled={busy}
                onClick={() => setRenameOpen(true)}
              />
              <PillButton
                testId={childTestId(testId, 'export')}
                variant="ghost"
                label={t('measurements_export')}
                disabled={busy}
                onClick={exportMeasurements}
              />
              <PillButton
                testId={childTestId(testId, 'import')}
                variant="ghost"
                label={t('measurements_import')}
                disabled={busy}
                onClick={() => importInputRef.current?.click()}
              />
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                className="climate-file-input"
                data-testid={childTestId(testId, 'import-file')}
                onChange={(event) => {
                  importMeasurements(event.target.files);
                  event.target.value = '';
                }}
              />
              <PillButton
                testId={childTestId(testId, 'clean')}
                variant="ghost"
                label={t('measurements_clean')}
                disabled={busy}
                onClick={cleanMeasurements}
              />
            </div>
          )}
        </div>
      )}
      <PanelCard
        testId={childTestId(testId, 'humidity')}
        title={t('climate_humidity_title')}
        actions={<PlotHelp topic="climate_chart" testId={childTestId(testId, 'humidity', 'help')} />}
      >
        {body('humidity', t('climate_humidity_axis'), '%')}
      </PanelCard>
      <PanelCard
        testId={childTestId(testId, 'temperature')}
        title={t('climate_temperature_title')}
        actions={<PlotHelp topic="climate_chart" testId={childTestId(testId, 'temperature', 'help')} />}
      >
        {body('temperature', t('climate_temperature_axis'), '°C')}
      </PanelCard>
      {showBattery && (
        <PanelCard
          testId={childTestId(testId, 'battery')}
          title={t('climate_battery_title')}
          actions={<PlotHelp topic="climate_chart" testId={childTestId(testId, 'battery', 'help')} />}
        >
          {body('battery', t('climate_battery_axis'), '%')}
        </PanelCard>
      )}
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
