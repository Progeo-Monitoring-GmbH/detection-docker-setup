import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Col,
  Container,
  Form,
  Row,
  Spinner,
} from 'react-bootstrap';
import {
  ArrowLeft,
  ArrowRight,
  Calendar3,
  Check2,
  XCircle,
} from 'react-bootstrap-icons';
import Plot from 'react-plotly.js';
import { useSnackbar } from 'notistack';

import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import {
  showErrorBar,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import { plotTheme } from '../styles/plotTheme';

type AlarmDailyReport = {
  id: number;
  date: string;
  total_count: number;
  active_count: number;
  normalized_count: number;
  acknowledged_count: number;
  stoppage_count: number;
  avg_duration_seconds: number | null;
  max_value: number | null;
  peak_sensor_id: number | null;
  max_value_at: string | null;
  locations: Record<string, { name?: string; project_id?: number | null; count?: number; active?: number; max_value?: number | null }>;
  sensors: Record<string, { count?: number; max_value?: number }>;
  hourly: Array<{ hour: number; count: number }>;
  top_alarms: Array<{
    id: number;
    location_id?: number | null;
    location_name?: string | null;
    sensor_ids?: number[];
    max_value?: number | null;
    triggered_at?: string | null;
    status?: number;
    active?: boolean;
  }>;
};

const DATE_FMT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
};

const formatDate = (iso: string): string => {
  const date = new Date(`${iso}T00:00:00`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, DATE_FMT);
};

const formatCount = (value: number | null | undefined): string =>
  value == null ? '-' : String(value);

const toMs = (iso?: string | null): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

const ReportSummaryCard = ({ report }: { report: AlarmDailyReport | null }) => {
  if (!report) {
    return (
      <Card className="border-0 shadow-sm h-100">
        <Card.Body className="text-muted text-center py-5">
          No report for this day yet.
        </Card.Body>
      </Card>
    );
  }

  const peakMs = toMs(report.max_value_at);
  return (
    <Card className="border-0 shadow-sm h-100">
      <Card.Body>
        <h6 className="text-muted text-uppercase small mb-3">
          <Calendar3 className="me-1" />
          {formatDate(report.date)}
        </h6>
        <Row className="g-3 text-center">
          <Col xs={6} md={4}>
            <div className="fs-4 fw-bold">{formatCount(report.total_count)}</div>
            <small className="text-muted">Total</small>
          </Col>
          <Col xs={6} md={4}>
            <div className="fs-4 fw-bold text-danger">{formatCount(report.active_count)}</div>
            <small className="text-muted">Active</small>
          </Col>
          <Col xs={6} md={4}>
            <div className="fs-4 fw-bold text-success">{formatCount(report.normalized_count)}</div>
            <small className="text-muted">Normalized</small>
          </Col>
          <Col xs={6} md={4}>
            <div className="fs-4 fw-bold text-secondary">{formatCount(report.acknowledged_count)}</div>
            <small className="text-muted">Acknowledged</small>
          </Col>
          <Col xs={6} md={4}>
            <div className="fs-4 fw-bold text-warning">{formatCount(report.stoppage_count)}</div>
            <small className="text-muted">Stoerung</small>
          </Col>
          <Col xs={6} md={4}>
            <div className="fs-4 fw-bold">{formatCount(report.max_value)}</div>
            <small className="text-muted">Max value</small>
          </Col>
        </Row>
        <div className="mt-3 small text-muted d-flex flex-wrap gap-3">
          <span>Locations: <strong>{Object.keys(report.locations || {}).length}</strong></span>
          <span>Sensors: <strong>{Object.keys(report.sensors || {}).length}</strong></span>
          {peakMs != null && (
            <span>
              Peak at:{' '}
              <strong>{new Date(peakMs).toLocaleTimeString()}</strong>
            </span>
          )}
        </div>
      </Card.Body>
    </Card>
  );
};

const AlarmReportView = () => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();

  const [reports, setReports] = useState<AlarmDailyReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const [selectedDate, setSelectedDate] = useState<string>('');
  const [report, setReport] = useState<AlarmDailyReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);

  // Comparison state: pick two dates from the available reports.
  const [compareA, setCompareA] = useState<string>('');
  const [compareB, setCompareB] = useState<string>('');
  const [comparison, setComparison] = useState<{
    report_a: AlarmDailyReport | null;
    report_b: AlarmDailyReport | null;
  } | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);

  const fetchReports = useCallback(() => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      '/v1/alarm-report/',
      (response) => {
        const next = (response?.data?.reports || []) as AlarmDailyReport[];
        setReports(next);
        setLoading(false);
        // Default selection: most recent report.
        if (next.length > 0) {
          setSelectedDate((current) => current || next[0].date);
        }
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not load reports: ${reason}`);
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const fetchReport = useCallback(
    (date: string) => {
      if (!date) return;
      setReportLoading(true);
      void axiosConfig.perform_get(
        auth,
        `/v1/alarm-report/?date=${date}`,
        (response) => {
          const list = (response?.data?.reports || []) as AlarmDailyReport[];
          setReport(list[0] || null);
          setReportLoading(false);
        },
        (error) => {
          const reason = error?.response?.data?.reason || error.message;
          showErrorBar(enqueueSnackbar, `Could not load report: ${reason}`);
          setReportLoading(false);
        },
      );
    },
    [auth, enqueueSnackbar],
  );

  useEffect(() => {
    if (selectedDate) {
      fetchReport(selectedDate);
    }
  }, [selectedDate, fetchReport]);

  const runCompare = useCallback(
    (dateA: string, dateB: string) => {
      if (!dateA || !dateB) return;
      setCompareLoading(true);
      void axiosConfig.perform_get(
        auth,
        `/v1/alarm-report/compare/?date_a=${dateA}&date_b=${dateB}`,
        (response) => {
          setComparison({
            report_a: response?.data?.report_a || null,
            report_b: response?.data?.report_b || null,
          });
          setCompareLoading(false);
        },
        (error) => {
          const reason = error?.response?.data?.reason || error.message;
          showErrorBar(enqueueSnackbar, `Could not compare reports: ${reason}`);
          setCompareLoading(false);
        },
      );
    },
    [auth, enqueueSnackbar],
  );

  useEffect(() => {
    if (compareA && compareB) {
      runCompare(compareA, compareB);
    } else {
      setComparison(null);
    }
  }, [compareA, compareB, runCompare]);

  const handleGenerate = () => {
    setGenerating(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/alarm-report/generate/',
      { date: selectedDate || undefined },
      (result) => {
        showSuccessBar(
          enqueueSnackbar,
          `Report generated${result?.data?.report?.date ? ` for ${result.data.report.date}` : ''}.`,
        );
        setGenerating(false);
        fetchReports();
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not generate report: ${reason}`);
        setGenerating(false);
      },
    );
  };

  const moveDate = (offset: number) => {
    if (!selectedDate) return;
    const current = new Date(`${selectedDate}T00:00:00`);
    current.setDate(current.getDate() + offset);
    const iso = current.toISOString().slice(0, 10);
    setSelectedDate(iso);
  };

  const dailyCounts = useMemo(() => {
    return [...reports]
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((item) => ({
        date: item.date,
        count: item.total_count,
      }));
  }, [reports]);

  const hourlyTrace = useCallback(
    (reportData: AlarmDailyReport | null, name: string) => {
      const hourly = reportData?.hourly || [];
      return {
        x: hourly.map((entry) => `${entry.hour}:00`),
        y: hourly.map((entry) => entry.count),
        type: 'bar' as const,
        name,
        marker: { color: plotTheme.brandBlue },
      };
    },
    [],
  );

  const sortedDates = useMemo(
    () => reports.map((item) => item.date).sort(),
    [reports],
  );

  return (
    <Container fluid>
      <div className="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
        <h5 className="mb-0">Alarm Reports</h5>
        <div className="d-flex gap-2">
          <Button variant="outline-secondary" size="sm" onClick={fetchReports}>
            Refresh
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={generating}
            onClick={handleGenerate}
          >
            {generating ? (
              <>
                <Spinner size="sm" animation="border" className="me-1" />
                Generating…
              </>
            ) : (
              'Generate report'
            )}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="d-flex align-items-center gap-2 text-muted py-5 justify-content-center">
          <Spinner size="sm" animation="border" />
          Loading reports…
        </div>
      ) : (
        <>
          {/* Daily alarm count graph */}
          <Card className="border-0 shadow-sm mb-4">
            <Card.Body>
              <h6 className="text-muted text-uppercase small mb-3">
                Alarms per day
              </h6>
              {dailyCounts.length === 0 ? (
                <div className="text-muted text-center py-4">
                  No reports available yet — generate one or wait for the daily
                  celery task.
                </div>
              ) : (
                <Plot
                  data={[
                    {
                      x: dailyCounts.map((item) => item.date),
                      y: dailyCounts.map((item) => item.count),
                      type: 'bar',
                      marker: {
                        color: dailyCounts.map((item) =>
                          item.date === selectedDate
                            ? plotTheme.brandOrange
                            : plotTheme.brandBlue,
                        ),
                      },
                      hovertemplate: '%{x}<br>%{y} alarms<extra></extra>',
                    },
                  ]}
                  layout={{
                    height: 260,
                    margin: { l: 48, r: 16, t: 12, b: 44 },
                    xaxis: { title: 'Date' },
                    yaxis: { title: 'Alarms' },
                    paper_bgcolor: 'transparent',
                    plot_bgcolor: 'transparent',
                    font: { family: 'inherit', color: plotTheme.brandBlue },
                  }}
                  config={{ responsive: true, displaylogo: false }}
                  style={{ width: '100%' }}
                  useResizeHandler
                  onClick={(event) => {
                    const point = event?.points?.[0];
                    const date = point?.x as string | undefined;
                    if (date) setSelectedDate(date);
                  }}
                />
              )}
            </Card.Body>
          </Card>

          {/* Navigation + selected report */}
          <Card className="border-0 shadow-sm mb-4">
            <Card.Body>
              <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
                <Button
                  variant="outline-secondary"
                  size="sm"
                  onClick={() => moveDate(-1)}
                  title="Previous day"
                >
                  <ArrowLeft />
                </Button>
                <Form.Select
                  value={selectedDate}
                  onChange={(event) => setSelectedDate(event.target.value)}
                  style={{ width: 220 }}
                  aria-label="Select report date"
                >
                  {sortedDates.length === 0 && (
                    <option value="">No reports</option>
                  )}
                  {sortedDates.map((date) => (
                    <option key={date} value={date}>
                      {formatDate(date)}
                    </option>
                  ))}
                </Form.Select>
                <Button
                  variant="outline-secondary"
                  size="sm"
                  onClick={() => moveDate(1)}
                  title="Next day"
                >
                  <ArrowRight />
                </Button>
                {reportLoading && <Spinner size="sm" animation="border" />}
                {report && (
                  <Badge bg="info" pill>
                    {formatDate(report.date)} · {report.total_count} alarms
                  </Badge>
                )}
              </div>

              {reportLoading ? (
                <div className="text-muted text-center py-4">
                  <Spinner size="sm" animation="border" /> Loading…
                </div>
              ) : (
                <ReportSummaryCard report={report} />
              )}
            </Card.Body>
          </Card>

          {/* Comparison */}
          <Card className="border-0 shadow-sm">
            <Card.Body>
              <h6 className="text-muted text-uppercase small mb-3">
                Compare two reports
              </h6>
              <div className="d-flex flex-wrap align-items-end gap-3 mb-3">
                <div>
                  <Form.Label className="small text-muted mb-1">
                    Report A
                  </Form.Label>
                  <Form.Select
                    value={compareA}
                    onChange={(event) => setCompareA(event.target.value)}
                    style={{ width: 200 }}
                  >
                    <option value="">— select —</option>
                    {sortedDates.map((date) => (
                      <option key={date} value={date}>
                        {formatDate(date)}
                      </option>
                    ))}
                  </Form.Select>
                </div>
                <div>
                  <Form.Label className="small text-muted mb-1">
                    Report B
                  </Form.Label>
                  <Form.Select
                    value={compareB}
                    onChange={(event) => setCompareB(event.target.value)}
                    style={{ width: 200 }}
                  >
                    <option value="">— select —</option>
                    {sortedDates.map((date) => (
                      <option key={date} value={date}>
                        {formatDate(date)}
                      </option>
                    ))}
                  </Form.Select>
                </div>
                {compareLoading && <Spinner size="sm" animation="border" />}
                {compareA && compareB && compareA === compareB && (
                  <Badge bg="warning" text="dark">
                    <XCircle className="me-1" />
                    Choose two different days
                  </Badge>
                )}
              </div>

              {comparison ? (
                <>
                  <Row className="g-3 mb-3">
                    <Col md={6}>
                      <ReportSummaryCard report={comparison.report_a} />
                    </Col>
                    <Col md={6}>
                      <ReportSummaryCard report={comparison.report_b} />
                    </Col>
                  </Row>

                  {/* Hourly distribution overlay */}
                  <Card className="border-0 bg-light">
                    <Card.Body>
                      <h6 className="text-muted text-uppercase small mb-2">
                        Hourly distribution
                      </h6>
                      <Plot
                        data={[
                          hourlyTrace(comparison.report_a, formatDate(compareA)),
                          hourlyTrace(comparison.report_b, formatDate(compareB)),
                        ]}
                        layout={{
                          height: 280,
                          barmode: 'group',
                          margin: { l: 48, r: 16, t: 12, b: 44 },
                          xaxis: { title: 'Hour' },
                          yaxis: { title: 'Alarms' },
                          paper_bgcolor: 'transparent',
                          plot_bgcolor: 'transparent',
                          font: {
                            family: 'inherit',
                            color: plotTheme.brandBlue,
                          },
                          legend: {
                            orientation: 'h',
                            y: 1.12,
                          },
                        }}
                        config={{
                          responsive: true,
                          displaylogo: false,
                        }}
                        style={{ width: '100%' }}
                        useResizeHandler
                      />
                    </Card.Body>
                  </Card>

                  {/* Top alarms side by side */}
                  <Row className="g-3 mt-1">
                    {['report_a', 'report_b'].map((key) => {
                      const data =
                        key === 'report_a'
                          ? comparison.report_a
                          : comparison.report_b;
                      const dateLabel =
                        key === 'report_a'
                          ? formatDate(compareA)
                          : formatDate(compareB);
                      return (
                        <Col md={6} key={key}>
                          <Card className="border-0 shadow-sm">
                            <Card.Body>
                              <h6 className="text-muted text-uppercase small mb-2">
                                Top alarms · {dateLabel}
                              </h6>
                              {!data || data.top_alarms.length === 0 ? (
                                <div className="text-muted small">
                                  No alarms this day.
                                </div>
                              ) : (
                                <ul className="list-unstyled mb-0 small">
                                  {data.top_alarms.map((alarm) => (
                                    <li
                                      key={alarm.id}
                                      className="d-flex justify-content-between gap-2 py-1 border-bottom"
                                    >
                                      <span>
                                        <Check2
                                          className="me-1 text-primary"
                                          size={12}
                                        />
                                        #{alarm.id} · {alarm.location_name}
                                        {alarm.sensor_ids &&
                                          alarm.sensor_ids.length > 0 &&
                                          ` · sensors ${alarm.sensor_ids.join(', ')}`}
                                      </span>
                                      <strong>{alarm.max_value ?? '-'}</strong>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </Card.Body>
                          </Card>
                        </Col>
                      );
                    })}
                  </Row>
                </>
              ) : (
                <div className="text-muted text-center py-4">
                  Select two reports above to compare them.
                </div>
              )}
            </Card.Body>
          </Card>
        </>
      )}
    </Container>
  );
};

export default AlarmReportView;
