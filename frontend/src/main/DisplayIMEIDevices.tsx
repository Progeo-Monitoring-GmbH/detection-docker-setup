import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, Row, Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import Plot from 'react-plotly.js';
import { Gear } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar, showInfoBar } from '../components/ui/Snackbar.jsx';
import { UserProfileModal } from './UserProfile.tsx';

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

const MAX_JSON_SAFE_RESISTANCE_OHM = 19_999_999.9;

const formatResistanceTooltip = (value: number) => {
  if (Math.abs(value - MAX_JSON_SAFE_RESISTANCE_OHM) < 1e-6) {
    return '∞ Ω';
  }
  return `${value.toFixed(2)} Ω`;
};

const formatDate = (value: string | null | undefined, language: string) => {
  if (!value) {
    return '-';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(language || 'de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(parsed);
};

const DisplayIMEIDevices = () => {
  const auth = useAuth();
  const { t, i18n } = useTranslation();
  const { enqueueSnackbar } = useSnackbar();
  const [loading, setLoading] = useState(true);
  const [devices, setDevices] = useState<ImeiDeviceSeries[]>([]);
  const [countMeasurements, setCountMeasurements] = useState(0);
  const [showUserProfileModal, setShowUserProfileModal] = useState(false);

  const openProfileSettings = () => {
    showInfoBar(enqueueSnackbar, t('profile_modal_opening'));
    setShowUserProfileModal(true);
  };

  const logout = () => {
    try {
      showInfoBar(enqueueSnackbar, t('profile_logout_info'));
      auth.logoutAction();
    } catch (error: any) {
      const reason = error?.message || t('profile_logout_unknown_error');
      showErrorBar(enqueueSnackbar, `${t('profile_logout_error')}: ${reason}`);
    }
  };

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
        showErrorBar(enqueueSnackbar, `${t('imei_load_error')}: ${reason}`);
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
              timeLabel: formatDate(entry.last_updated, i18n.language),
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
          plotTooltipVdc: vdcPoints.map((point) =>
            formatResistanceTooltip(point.resistanceVdc as number),
          ),
          plotXIdc: idcPoints.map((point) =>
            new Date(point.timeMs).toISOString(),
          ),
          plotYIdc: idcPoints.map((point) => point.resistanceIdc as number),
          plotTooltipIdc: idcPoints.map((point) =>
            formatResistanceTooltip(point.resistanceIdc as number),
          ),
          points,
        };
      })
      .filter((device) => device.points.length > 0);
  }, [devices, i18n.language]);

  if (loading) {
    return (
      <div className="py-4 d-flex align-items-center gap-3">
        <Spinner animation="border" role="status" />
        <span>{t('imei_loading')}</span>
      </div>
    );
  }

  return (
    <Col>
      <div className="d-flex justify-content-between align-items-center mb-4">
        <div>
          <h2 className="mb-1">{t('imei_title')}</h2>
          <small className="text-muted d-inline-block mt-1">
            {t('imei_summary', {
              deviceCount: normalized.length,
              measurementCount: countMeasurements,
            })}
          </small>
        </div>
        <div className="d-flex gap-2">
          <Button variant="outline-primary" onClick={openProfileSettings}>
            <Gear className="me-2" />
            {t('profile_settings_button')}
          </Button>
          <Button variant="danger" onClick={logout}>
            {t('profile_logout')}
          </Button>
        </div>
      </div>

      <UserProfileModal
        show={showUserProfileModal}
        onHide={() => setShowUserProfileModal(false)}
      />

      {!normalized.length && (
        <Card className="border-0 shadow-sm">
          <Card.Body>{t('imei_no_measurements')}</Card.Body>
        </Card>
      )}

      <Row className="g-4">
        {normalized.map((device) => {
          const latest = device.points[device.points.length - 1];

          return (
            <Col key={device.imei} xs={12}>
              <Card className="shadow-sm border rounded-3 border-secondary-subtle">
                <Card.Body className="p-4 m-2">
                  <div className="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
                    <div>
                      <h5 className="mb-0">IMEI {device.imei}</h5>
                      <small className="text-muted d-inline-block mt-1">
                        {t('imei_device_id')}: {device.device_id || '-'}
                      </small>
                    </div>
                    <small className="text-muted">
                      {t('imei_points_latest', {
                        pointCount: device.points.length,
                      })}{' '}
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
                        customdata: device.plotTooltipVdc,
                        hovertemplate:
                          '<b>VDC</b><br>%{x|%d.%m.%Y, %H:%M:%S}<br><b>%{customdata}</b><extra></extra>',
                      },
                      {
                        x: device.plotXIdc,
                        y: device.plotYIdc,
                        type: 'scatter',
                        mode: 'lines+markers',
                        name: 'IDC',
                        line: { color: '#22c55e', width: 2.5 },
                        marker: { size: 6 },
                        customdata: device.plotTooltipIdc,
                        hovertemplate:
                          '<b>IDC</b><br>%{x|%d.%m.%Y, %H:%M:%S}<br><b>%{customdata}</b><extra></extra>',
                      },
                    ]}
                    layout={{
                      autosize: true,
                      height: 360,
                      margin: { l: 60, r: 20, t: 92, b: 64 },
                      hovermode: 'x unified',
                      font: { color: '#f8fbff' },
                      paper_bgcolor: 'transparent',
                      plot_bgcolor: '#111827',
                      hoverlabel: {
                        bgcolor: '#0f172a',
                        bordercolor: '#94a3b8',
                        font: { color: '#e2e8f0', size: 13 },
                      },
                      hoverdistance: 40,
                      spikedistance: -1,
                      xaxis: {
                        title: {
                          text: t('imei_axis_time'),
                          font: { color: '#ffffff' },
                        },
                        type: 'date',
                        tickformat: '%Y-%m-%d %H:%M',
                        tickfont: { color: '#f8fbff' },
                        gridcolor: 'rgba(255, 255, 255, 0.20)',
                        zerolinecolor: 'rgba(255, 255, 255, 0.35)',
                        showspikes: true,
                        spikethickness: 1,
                        spikecolor: 'rgba(148, 163, 184, 0.85)',
                        spikesnap: 'cursor',
                        spikemode: 'across',
                      },
                      yaxis: {
                        title: {
                          text: t('imei_axis_resistance'),
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
                        y: 1.18,
                        xanchor: 'left',
                        x: 0,
                        bgcolor: 'rgba(15, 23, 42, 0.55)',
                        bordercolor: 'rgba(148, 163, 184, 0.3)',
                        borderwidth: 1,
                      },
                    }}
                    useResizeHandler={true}
                    style={{ width: '100%' }}
                    config={{ displayModeBar: 'hover', responsive: true }}
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
