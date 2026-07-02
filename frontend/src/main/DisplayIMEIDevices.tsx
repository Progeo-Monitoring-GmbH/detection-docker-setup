import { useEffect, useMemo, useState } from 'react';
import { Card, Col, Row, Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import Plot from 'react-plotly.js';

import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar } from '../components/ui/Snackbar.jsx';

type ImeiMeasurementPoint = {
  id: number;
  last_updated: string | null;
  resistance_idc: number | null;
  resistance_vdc: number | null;
};

type ImeiDeviceSeries = {
  imei: string;
  device_id?: number;
  device_hash?: string;
  measurements: ImeiMeasurementPoint[];
};

const formatDate = (value: string | null | undefined) => {
  if (!value) {
    return '-';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
};

const DisplayIMEIDevices = () => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [loading, setLoading] = useState(true);
  const [devices, setDevices] = useState<ImeiDeviceSeries[]>([]);
  const [countMeasurements, setCountMeasurements] = useState(0);

  const loadData = () => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      '/v1/device/imei/display/',
      (response) => {
        const responseDevices = (response?.data?.devices ||
          []) as ImeiDeviceSeries[];
        setDevices(responseDevices);
        setCountMeasurements(Number(response?.data?.count_measurements || 0));
        setLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(
          enqueueSnackbar,
          `Could not load IMEI resistance data: ${reason}`,
        );
        setDevices([]);
        setCountMeasurements(0);
        setLoading(false);
      },
    );
  };

  useEffect(() => {
    loadData();
  }, []);

  const normalized = useMemo(() => {
    return devices
      .map((device) => {
        const points = (device.measurements || [])
          .map((entry) => {
            const timeMs = entry.last_updated
              ? new Date(entry.last_updated).getTime()
              : Number.NaN;
            const resistanceVdc = Number(entry.resistance_vdc);
            const resistanceIdc = Number(entry.resistance_idc);
            const hasVdc = Number.isFinite(resistanceVdc) && resistanceVdc > 0;
            const hasIdc = Number.isFinite(resistanceIdc) && resistanceIdc > 0;

            if (!Number.isFinite(timeMs) || (!hasVdc && !hasIdc)) {
              return null;
            }

            return {
              id: entry.id,
              timeMs,
              timeLabel: formatDate(entry.last_updated),
              resistanceVdc: hasVdc ? resistanceVdc : null,
              resistanceIdc: hasIdc ? resistanceIdc : null,
            };
          })
          .filter(
            (
              value,
            ): value is {
              id: number;
              timeMs: number;
              timeLabel: string;
              resistanceVdc: number | null;
              resistanceIdc: number | null;
            } => Boolean(value),
          )
          .sort((a, b) => a.timeMs - b.timeMs);

        const vdcPoints = points.filter(
          (point) => point.resistanceVdc !== null,
        );
        const idcPoints = points.filter(
          (point) => point.resistanceIdc !== null,
        );

        return {
          imei: device.imei,
          device_id: device.device_id,
          plotXVdc: vdcPoints.map((point) =>
            new Date(point.timeMs).toISOString(),
          ),
          plotYVdc: vdcPoints.map((point) => point.resistanceVdc as number),
          plotXIdc: idcPoints.map((point) =>
            new Date(point.timeMs).toISOString(),
          ),
          plotYIdc: idcPoints.map((point) => point.resistanceIdc as number),
          points,
        };
      })
      .filter((device) => device.points.length > 0);
  }, [devices]);

  if (loading) {
    return (
      <div className="py-4 d-flex align-items-center gap-3">
        <Spinner animation="border" role="status" />
        <span>Loading IMEI resistance charts...</span>
      </div>
    );
  }

  return (
    <Col>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <div>
          <h2 className="mb-0">Display IMEI Devices</h2>
          <small className="text-muted">
            {normalized.length} IMEI devices, {countMeasurements} measurements
            with resistance
          </small>
        </div>
      </div>

      {!normalized.length && (
        <Card className="border-0 shadow-sm">
          <Card.Body>No IMEI measurements with resistance found.</Card.Body>
        </Card>
      )}

      <Row className="g-3">
        {normalized.map((device) => {
          const latest = device.points[device.points.length - 1];

          return (
            <Col key={device.imei} xs={12}>
              <Card className="border-0 shadow-sm">
                <Card.Body>
                  <div className="d-flex flex-wrap justify-content-between align-items-center mb-2">
                    <div>
                      <h5 className="mb-0">IMEI {device.imei}</h5>
                      <small className="text-muted">
                        Device ID: {device.device_id || '-'}
                      </small>
                    </div>
                    <small className="text-muted">
                      {device.points.length} points, latest:{' '}
                      {latest?.timeLabel || '-'}
                    </small>
                  </div>

                  <Plot
                    data={[
                      {
                        x: device.plotXVdc,
                        y: device.plotYVdc,
                        type: 'scatter',
                        mode: 'lines+markers',
                        name: 'VDC',
                        line: { color: '#0d6efd', width: 2.5 },
                        marker: { size: 6 },
                      },
                      {
                        x: device.plotXIdc,
                        y: device.plotYIdc,
                        type: 'scatter',
                        mode: 'lines+markers',
                        name: 'IDC',
                        line: { color: '#22c55e', width: 2.5 },
                        marker: { size: 6 },
                      },
                    ]}
                    layout={{
                      autosize: true,
                      height: 320,
                      margin: { l: 60, r: 20, t: 10, b: 60 },
                      font: { color: '#f8fbff' },
                      paper_bgcolor: 'transparent',
                      plot_bgcolor: '#111827',
                      hoverlabel: {
                        bgcolor: '#0b1220',
                        bordercolor: '#94a3b8',
                        font: { color: '#f8fbff' },
                      },
                      xaxis: {
                        title: {
                          text: 'Empfangszeit',
                          font: { color: '#ffffff' },
                        },
                        type: 'date',
                        tickformat: '%Y-%m-%d %H:%M',
                        tickfont: { color: '#f8fbff' },
                        gridcolor: 'rgba(255, 255, 255, 0.20)',
                        zerolinecolor: 'rgba(255, 255, 255, 0.35)',
                      },
                      yaxis: {
                        title: {
                          text: 'Widerstand [log Ω]',
                          font: { color: '#ffffff' },
                        },
                        type: 'log',
                        automargin: true,
                        tickfont: { color: '#f8fbff' },
                        gridcolor: 'rgba(255, 255, 255, 0.20)',
                        zerolinecolor: 'rgba(255, 255, 255, 0.35)',
                      },
                      showlegend: true,
                      legend: {
                        orientation: 'h',
                        yanchor: 'bottom',
                        y: 1.02,
                        xanchor: 'right',
                        x: 1,
                      },
                    }}
                    useResizeHandler={true}
                    style={{ width: '100%' }}
                    config={{ displayModeBar: true, responsive: true }}
                  />
                </Card.Body>
              </Card>
            </Col>
          );
        })}
      </Row>
    </Col>
  );
};

export default DisplayIMEIDevices;
