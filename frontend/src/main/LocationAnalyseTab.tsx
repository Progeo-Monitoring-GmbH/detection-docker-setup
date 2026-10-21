import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router';
import { Card, Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { downloadResponse, openResponseInNewTab } from '../helper';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import SensorHeatmap2D from '../components/device/SensorHeatmap2D.tsx';
import { type SensorHeatmapResponse } from '../components/device/SensorHeatmap3D.tsx';
import MeasurementSamplesCompareChart, {
  type MeasurementCompareRow,
} from '../components/device/MeasurementSamplesCompareChart.tsx';
import type { PortalOutletContext } from './LocationPortalLayout';
import LocationClimatePanels from './LocationClimatePanels';
import { isLorawanProject } from './projectType';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import {
  SHORT_TIME_RANGES,
  TIME_RANGE_DAYS,
  timeRangeLabelKey,
  type TimeRange,
} from './timeRanges';

/** Most measurements per period - spread evenly over it by the backend (?days=). */
const MAX_MEASUREMENTS = 300;

/**
 * Analyse route: the location heatmap plus the measurements of all its
 * devices over the selected period (last 24 h / 7 / 30 days). Reuses the
 * existing heatmap + measurement endpoints and components.
 */
const LocationAnalyseTab = () => {
  const { location, locationId } = useOutletContext<PortalOutletContext>();
  // LoRaWAN objects have no samples - humidity/temperature charts replace
  // the heatmap and the samples chart.
  const isLorawan = isLorawanProject(location?.project_type);
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();

  const [range, setRange] = useState<TimeRange>('7d');
  const [heatmap, setHeatmap] = useState<SensorHeatmapResponse | null>(null);
  const [measurements, setMeasurements] = useState<MeasurementCompareRow[]>([]);
  // Measurements in the period, of which `measurements` are shown.
  const [measurementTotal, setMeasurementTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // Only the newest request may set the data - switching periods quickly
  // must not let a slower, older response win.
  const requestId = useRef(0);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
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

  const loadAll = useCallback(() => {
    if (isLorawan) {
      return;
    }
    setLoading(true);
    const current = ++requestId.current;
    const isCurrent = () => current === requestId.current;
    const query = `days=${TIME_RANGE_DAYS[range]}&limit=${MAX_MEASUREMENTS}`;

    const loadHeatmap = (done: () => void) => {
      void axiosConfig.perform_get(
        auth,
        `/v1/location/${locationId}/heatmap/?${query}`,
        (response) => {
          if (isCurrent()) {
            setHeatmap((response?.data || null) as SensorHeatmapResponse | null);
          }
          done();
        },
        (error) => {
          if (isCurrent()) {
            showRequestError(enqueueSnackbar, 'Could not load heatmap', error);
          }
          done();
        },
      );
    };

    const loadMeasurements = (done: () => void) => {
      void axiosConfig.perform_get(
        auth,
        `/v1/location/${locationId}/measurements/?${query}`,
        (response) => {
          if (isCurrent()) {
            const rows = (response?.data?.measurements ||
              []) as MeasurementCompareRow[];
            setMeasurements(rows);
            setMeasurementTotal(Number(response?.data?.total ?? rows.length));
          }
          done();
        },
        (error) => {
          if (isCurrent()) {
            showRequestError(enqueueSnackbar, 'Could not load measurements', error);
          }
          done();
        },
      );
    };

    let pending = 2;
    const done = () => {
      pending -= 1;
      if (pending === 0 && isCurrent()) {
        setLoading(false);
      }
    };
    loadHeatmap(done);
    loadMeasurements(done);
  }, [auth, enqueueSnackbar, isLorawan, locationId, range]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

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
        <LocationClimatePanels locationId={locationId} />
      ) : (
        <>
          <div className="d-flex flex-wrap align-items-center gap-3">
            <SegmentedControl
              options={SHORT_TIME_RANGES.map((value) => ({
                value,
                label: t(timeRangeLabelKey(value)),
              }))}
              value={range}
              onChange={(value) => setRange(value as TimeRange)}
            />
            {loading && (heatmap || measurements.length > 0) && (
              <Spinner size="sm" animation="border" className="text-muted" />
            )}
          </div>

          <Card className="border-0 shadow-sm p-2">
            <Card.Body>
              <h5 className="mb-2">Heatmap</h5>
              {loading && !heatmap ? (
                <div className="d-flex align-items-center gap-2 text-muted py-4">
                  <Spinner size="sm" animation="border" /> Loading heatmap...
                </div>
              ) : (
                <SensorHeatmap2D response={heatmap} />
              )}
            </Card.Body>
          </Card>

          <Card className="border-0 shadow-sm p-2">
            <Card.Body>
              <h5 className="mb-1">{t('analyse_measurements_title')}</h5>
              {measurementTotal > measurements.length && (
                <div className="text-muted small mb-2">
                  {t('analyse_spread', {
                    count: measurements.length,
                    total: measurementTotal,
                  })}
                </div>
              )}
              {loading && measurements.length === 0 ? (
                <div className="d-flex align-items-center gap-2 text-muted py-4">
                  <Spinner size="sm" animation="border" /> Loading measurements...
                </div>
              ) : measurements.length === 0 ? (
                <div className="text-muted py-4 text-center">
                  {t('analyse_no_measurements')}
                </div>
              ) : (
                <MeasurementSamplesCompareChart rows={measurements} />
              )}
            </Card.Body>
          </Card>
        </>
      )}
    </div>
  );
};

export default LocationAnalyseTab;
