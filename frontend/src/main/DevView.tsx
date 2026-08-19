import './../components/ui/css/Dev.css';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import {
  Alert,
  Button,
  Card,
  Col,
  Container,
  Row,
  Table,
} from 'react-bootstrap';
import {
  ArrowClockwise,
  BarChart,
  Download,
  Stopwatch,
} from 'react-bootstrap-icons';
import axiosConfig from '../axiosConfig';

type BootMetrics = {
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
  domInteractiveMs: number | null;
  firstPaintMs: number | null;
  firstContentfulPaintMs: number | null;
  usedJsHeapMb: number | null;
};

type ModuleResult = {
  name: string;
  durationMs: number;
  transferSizeKb: number;
  decodedBodySizeKb: number;
  resourceCount: number;
  status: 'ok' | 'error';
  error?: string;
};

type ApiResult = {
  name: string;
  url: string;
  durationMs: number;
  payloadKb: number;
  statusCode: number | null;
  status: 'ok' | 'error';
  error?: string;
};

const moduleTests: Array<{ name: string; importer: () => Promise<unknown> }> = [
  { name: 'DeviceListView', importer: () => import('./DeviceListView') },
  { name: 'DeviceDetailView', importer: () => import('./DeviceDetailView') },
  { name: 'DeviceEditorView', importer: () => import('./DeviceEditorView') },
  { name: 'WsDebugView', importer: () => import('./WsDebugView') },
  { name: 'BackupView', importer: () => import('./BackupView.jsx') },
];

const apiTests: Array<{ name: string; url: string }> = [
  { name: 'Device Status', url: '/v1/status/devices/' },
  { name: 'Connected Devices', url: '/v1/status/list_connected/' },
  {
    name: 'Measure Points (sample)',
    url: '/v1/status/measure_points/?device_id=1',
  },
];

const toKb = (value: number) => Number((value / 1024).toFixed(2));

const DevView = () => {
  const auth = useAuth();
  const [bootMetrics, setBootMetrics] = useState<BootMetrics>({
    domContentLoadedMs: null,
    loadEventMs: null,
    domInteractiveMs: null,
    firstPaintMs: null,
    firstContentfulPaintMs: null,
    usedJsHeapMb: null,
  });
  const [moduleResults, setModuleResults] = useState<ModuleResult[]>([]);
  const [apiResults, setApiResults] = useState<ApiResult[]>([]);
  const [isRunningModules, setIsRunningModules] = useState(false);
  const [isRunningApis, setIsRunningApis] = useState(false);
  const [lastRun, setLastRun] = useState<string>('never');

  const collectBootMetrics = () => {
    const navEntry = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    const paintEntries = performance.getEntriesByType('paint');
    const firstPaint = paintEntries.find(
      (entry) => entry.name === 'first-paint',
    );
    const firstContentfulPaint = paintEntries.find(
      (entry) => entry.name === 'first-contentful-paint',
    );

    const mem = (performance as any).memory;
    const usedJsHeapMb = mem?.usedJSHeapSize
      ? Number((mem.usedJSHeapSize / (1024 * 1024)).toFixed(2))
      : null;

    setBootMetrics({
      domContentLoadedMs: navEntry
        ? Number(navEntry.domContentLoadedEventEnd.toFixed(2))
        : null,
      loadEventMs: navEntry ? Number(navEntry.loadEventEnd.toFixed(2)) : null,
      domInteractiveMs: navEntry
        ? Number(navEntry.domInteractive.toFixed(2))
        : null,
      firstPaintMs: firstPaint ? Number(firstPaint.startTime.toFixed(2)) : null,
      firstContentfulPaintMs: firstContentfulPaint
        ? Number(firstContentfulPaint.startTime.toFixed(2))
        : null,
      usedJsHeapMb,
    });
  };

  const runModuleDiagnostics = async () => {
    setIsRunningModules(true);
    const results: ModuleResult[] = [];

    for (const testCase of moduleTests) {
      const beforeResources = performance.getEntriesByType(
        'resource',
      ) as PerformanceResourceTiming[];
      const beforeCount = beforeResources.length;
      const started = performance.now();

      try {
        await testCase.importer();
        const finished = performance.now();
        const afterResources = performance.getEntriesByType(
          'resource',
        ) as PerformanceResourceTiming[];
        const newResources = afterResources.slice(beforeCount);

        const transferSize = newResources.reduce(
          (sum, entry) => sum + (entry.transferSize || 0),
          0,
        );
        const decodedBodySize = newResources.reduce(
          (sum, entry) => sum + (entry.decodedBodySize || 0),
          0,
        );

        results.push({
          name: testCase.name,
          durationMs: Number((finished - started).toFixed(2)),
          transferSizeKb: toKb(transferSize),
          decodedBodySizeKb: toKb(decodedBodySize),
          resourceCount: newResources.length,
          status: 'ok',
        });
      } catch (error: any) {
        const finished = performance.now();
        results.push({
          name: testCase.name,
          durationMs: Number((finished - started).toFixed(2)),
          transferSizeKb: 0,
          decodedBodySizeKb: 0,
          resourceCount: 0,
          status: 'error',
          error: error?.message || 'Unknown import error',
        });
      }
    }

    setModuleResults(results);
    setIsRunningModules(false);
    setLastRun(new Date().toLocaleString());
  };

  const runApiDiagnostics = async () => {
    setIsRunningApis(true);
    const results: ApiResult[] = [];

    axiosConfig.updateToken();

    for (const testCase of apiTests) {
      const started = performance.now();
      try {
        const response = await axiosConfig.holder.get(testCase.url);
        const finished = performance.now();
        const payloadKb = toKb(JSON.stringify(response?.data || {}).length);
        results.push({
          name: testCase.name,
          url: testCase.url,
          durationMs: Number((finished - started).toFixed(2)),
          payloadKb,
          statusCode: response.status,
          status: 'ok',
        });
      } catch (error: any) {
        const finished = performance.now();
        if (error?.response?.status === 401 && auth?.token) {
          auth.navigate(`/login?forward=${auth.location}`);
        }
        const dataLength = error?.response?.data
          ? JSON.stringify(error.response.data).length
          : 0;
        results.push({
          name: testCase.name,
          url: testCase.url,
          durationMs: Number((finished - started).toFixed(2)),
          payloadKb: toKb(dataLength),
          statusCode: error?.response?.status || null,
          status: 'error',
          error: error?.message || 'Unknown request error',
        });
      }
    }

    setApiResults(results);
    setIsRunningApis(false);
    setLastRun(new Date().toLocaleString());
  };

  const runAllDiagnostics = async () => {
    collectBootMetrics();
    await runModuleDiagnostics();
    await runApiDiagnostics();
  };

  useEffect(() => {
    collectBootMetrics();
  }, []);

  const moduleSummary = useMemo(() => {
    if (!moduleResults.length) {
      return { totalDuration: 0, totalSize: 0, failed: 0 };
    }
    return {
      totalDuration: Number(
        moduleResults.reduce((sum, row) => sum + row.durationMs, 0).toFixed(2),
      ),
      totalSize: Number(
        moduleResults
          .reduce((sum, row) => sum + row.transferSizeKb, 0)
          .toFixed(2),
      ),
      failed: moduleResults.filter((row) => row.status === 'error').length,
    };
  }, [moduleResults]);

  const apiSummary = useMemo(() => {
    if (!apiResults.length) {
      return { totalDuration: 0, totalPayload: 0, failed: 0 };
    }
    return {
      totalDuration: Number(
        apiResults.reduce((sum, row) => sum + row.durationMs, 0).toFixed(2),
      ),
      totalPayload: Number(
        apiResults.reduce((sum, row) => sum + row.payloadKb, 0).toFixed(2),
      ),
      failed: apiResults.filter((row) => row.status === 'error').length,
    };
  }, [apiResults]);

  return (
    <Container fluid className="dev-view py-4">
      <Row className="mb-3 g-3 align-items-stretch">
        <Col lg={8}>
          <Card className="h-100">
            <Card.Body>
              <h3 className="mb-2">Frontend Diagnostics</h3>
              <p className="text-muted mb-3">
                Measure startup timing, module loading duration/size, and API
                response costs to locate frontend bottlenecks.
              </p>
              <div className="d-flex gap-2 flex-wrap">
                <Button
                  variant="primary"
                  onClick={runAllDiagnostics}
                  disabled={isRunningModules || isRunningApis}
                >
                  <BarChart className="me-2" />
                  Run Full Diagnostics
                </Button>
                <Button
                  variant="outline-primary"
                  onClick={runModuleDiagnostics}
                  disabled={isRunningModules}
                >
                  <Download className="me-2" />
                  Test Module Imports
                </Button>
                <Button
                  variant="outline-secondary"
                  onClick={runApiDiagnostics}
                  disabled={isRunningApis}
                >
                  <Stopwatch className="me-2" />
                  Test API Timing
                </Button>
                <Button variant="outline-dark" onClick={collectBootMetrics}>
                  <ArrowClockwise className="me-2" />
                  Refresh Browser Metrics
                </Button>
              </div>
            </Card.Body>
          </Card>
        </Col>
        <Col lg={4}>
          <Card className="h-100">
            <Card.Body>
              <h6 className="mb-3">Last Run</h6>
              <div className="fw-bold">{lastRun}</div>
              <hr />
              <div className="small text-muted">
                Module failures: <strong>{moduleSummary.failed}</strong>
              </div>
              <div className="small text-muted">
                API failures: <strong>{apiSummary.failed}</strong>
              </div>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      <Row className="g-3 mb-3">
        <Col lg={4}>
          <Card className="metric-card">
            <Card.Body>
              <h6>Startup Metrics (ms)</h6>
              <div>
                DOMContentLoaded: {bootMetrics.domContentLoadedMs ?? '-'}
              </div>
              <div>DOM Interactive: {bootMetrics.domInteractiveMs ?? '-'}</div>
              <div>Load Event End: {bootMetrics.loadEventMs ?? '-'}</div>
              <div>First Paint: {bootMetrics.firstPaintMs ?? '-'}</div>
              <div>FCP: {bootMetrics.firstContentfulPaintMs ?? '-'}</div>
              <div>JS Heap Used (MB): {bootMetrics.usedJsHeapMb ?? '-'}</div>
            </Card.Body>
          </Card>
        </Col>
        <Col lg={4}>
          <Card className="metric-card">
            <Card.Body>
              <h6>Module Summary</h6>
              <div>Total Duration: {moduleSummary.totalDuration} ms</div>
              <div>Total Transfer: {moduleSummary.totalSize} KB</div>
              <div>Checked Modules: {moduleResults.length}</div>
              <div>Failures: {moduleSummary.failed}</div>
            </Card.Body>
          </Card>
        </Col>
        <Col lg={4}>
          <Card className="metric-card">
            <Card.Body>
              <h6>API Summary</h6>
              <div>Total Duration: {apiSummary.totalDuration} ms</div>
              <div>Total Payload: {apiSummary.totalPayload} KB</div>
              <div>Checked Endpoints: {apiResults.length}</div>
              <div>Failures: {apiSummary.failed}</div>
            </Card.Body>
          </Card>
        </Col>
      </Row>

      <Row className="g-3">
        <Col lg={7}>
          <Card>
            <Card.Header>Module Import Diagnostics</Card.Header>
            <Card.Body className="p-0">
              <Table striped hover responsive className="mb-0">
                <thead>
                  <tr>
                    <th>Module</th>
                    <th>Status</th>
                    <th>Duration (ms)</th>
                    <th>Transfer (KB)</th>
                    <th>Decoded (KB)</th>
                    <th>Resources</th>
                  </tr>
                </thead>
                <tbody>
                  {moduleResults.map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td>{row.status}</td>
                      <td>{row.durationMs}</td>
                      <td>{row.transferSizeKb}</td>
                      <td>{row.decodedBodySizeKb}</td>
                      <td>{row.resourceCount}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {!moduleResults.length && (
                <div className="p-3 text-muted">
                  Run module diagnostics to see import timings and chunk sizes.
                </div>
              )}
            </Card.Body>
          </Card>
        </Col>
        <Col lg={5}>
          <Card>
            <Card.Header>API Timing Diagnostics</Card.Header>
            <Card.Body className="p-0">
              <Table striped hover responsive className="mb-0">
                <thead>
                  <tr>
                    <th>Endpoint</th>
                    <th>Status</th>
                    <th>Code</th>
                    <th>Duration (ms)</th>
                    <th>Payload (KB)</th>
                  </tr>
                </thead>
                <tbody>
                  {apiResults.map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td>{row.status}</td>
                      <td>{row.statusCode ?? '-'}</td>
                      <td>{row.durationMs}</td>
                      <td>{row.payloadKb}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {!apiResults.length && (
                <div className="p-3 text-muted">
                  Run API diagnostics to compare latency and payload weight.
                </div>
              )}
            </Card.Body>
          </Card>
        </Col>
      </Row>

      {(moduleSummary.failed > 0 || apiSummary.failed > 0) && (
        <Row className="mt-3">
          <Col>
            <Alert variant="warning" className="mb-0">
              At least one diagnostic test failed. Check backend availability,
              endpoint permissions, or import path issues.
            </Alert>
          </Col>
        </Row>
      )}
    </Container>
  );
};

export default DevView;
