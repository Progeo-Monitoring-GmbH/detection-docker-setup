import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router';
import { Card, Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { openPostResponseInNewTab, openResponseInNewTab } from '../helper';
import { showErrorBar } from '../components/ui/Snackbar.jsx';
import SensorHeatmap2D from '../components/device/SensorHeatmap2D.tsx';
import { type SensorHeatmapResponse } from '../components/device/SensorHeatmap3D.tsx';
import MeasurementSamplesCompareChart, {
  type MeasurementCompareRow,
} from '../components/device/MeasurementSamplesCompareChart.tsx';
import type { PortalOutletContext } from './LocationPortalLayout';

const HEATMAP_LIMIT = 300;

/**
 * Analyse route: the location heatmap plus the recent measurements of all
 * its devices. Reuses the existing heatmap + measurement endpoints and
 * components.
 */
const LocationAnalyseTab = () => {
  const { locationId } = useOutletContext<PortalOutletContext>();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();

  const [heatmap, setHeatmap] = useState<SensorHeatmapResponse | null>(null);
  const [measurements, setMeasurements] = useState<MeasurementCompareRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);

  const exportCsv = () => {
    void openResponseInNewTab(auth, `/v1/location/${locationId}/export_csv/`);
    setExportMsg(t('analyse_export_csv_done'));
  };

  const exportPdf = () => {
    setExportingPdf(true);
    void openPostResponseInNewTab(`/v1/location/${locationId}/export_pdf/`, {}, auth).then(() => {
      setExportingPdf(false);
      setExportMsg(t('analyse_export_pdf_done'));
    });
  };

  const loadAll = useCallback(() => {
    setLoading(true);

    const loadHeatmap = (done: () => void) => {
      void axiosConfig.perform_get(
        auth,
        `/v1/location/${locationId}/heatmap/?limit=${HEATMAP_LIMIT}`,
        (response) => {
          setHeatmap((response?.data || null) as SensorHeatmapResponse | null);
          done();
        },
        (error) => {
          const reason = error?.response?.data?.reason || error.message;
          showErrorBar(enqueueSnackbar, `Could not load heatmap: ${reason}`);
          done();
        },
      );
    };

    const loadMeasurements = (done: () => void) => {
      void axiosConfig.perform_get(
        auth,
        `/v1/location/${locationId}/measurements/?limit=${HEATMAP_LIMIT}`,
        (response) => {
          setMeasurements(
            (response?.data?.measurements || []) as MeasurementCompareRow[],
          );
          done();
        },
        (error) => {
          const reason = error?.response?.data?.reason || error.message;
          showErrorBar(enqueueSnackbar, `Could not load measurements: ${reason}`);
          done();
        },
      );
    };

    let pending = 2;
    const done = () => {
      pending -= 1;
      if (pending === 0) {
        setLoading(false);
      }
    };
    loadHeatmap(done);
    loadMeasurements(done);
  }, [auth, enqueueSnackbar, locationId]);

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
          <h5 className="mb-2">Measurements (last {HEATMAP_LIMIT})</h5>
          {loading && measurements.length === 0 ? (
            <div className="d-flex align-items-center gap-2 text-muted py-4">
              <Spinner size="sm" animation="border" /> Loading measurements...
            </div>
          ) : measurements.length === 0 ? (
            <div className="text-muted py-4 text-center">
              No measurements found for this location yet.
            </div>
          ) : (
            <MeasurementSamplesCompareChart rows={measurements} />
          )}
        </Card.Body>
      </Card>
    </div>
  );
};

export default LocationAnalyseTab;
