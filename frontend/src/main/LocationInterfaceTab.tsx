import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Form, Row, Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import {
  showErrorBar,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';

const PASSWORD_MASK = '********';

type SmtpConfig = {
  sender?: string;
  reply_to?: string;
  server?: string;
  port?: number;
  username?: string;
  password?: string;
};

type ModbusConfig = {
  host?: string;
  port?: number;
  unit_id?: number;
  timeout?: number;
  start_address?: number;
};

type TestResult = {
  ok?: boolean;
  steps?: string[];
  error?: string;
};

/**
 * Inline visual result of a "Test connection" run: green when ok, red with
 * the error and the steps reached so far when the test failed.
 */
const TestFeedback = ({ result }: { result: TestResult | null }) => {
  if (!result) {
    return null;
  }
  const ok = Boolean(result.ok);
  return (
    <Alert
      variant={ok ? 'success' : 'danger'}
      className="mt-3 mb-0 py-2 small"
    >
      <div className="fw-semibold">
        {ok ? 'Test successful' : 'Test failed'}
      </div>
      {result.error && <div className="text-break">{result.error}</div>}
      {Array.isArray(result.steps) && result.steps.length > 0 && (
        <ul className="mb-0 mt-1 ps-3">
          {result.steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
};

/**
 * Schnittstelle tab: runtime configuration of the SMTP server and the Modbus
 * connection (stored in SystemConfig, falls back to django.env until saved).
 */
const LocationInterfaceTab = () => {
  return (
    <div className="d-flex flex-column gap-4">
      <SmtpConfigCard />
      <ModbusConfigCard />
    </div>
  );
};

const SmtpConfigCard = () => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [config, setConfig] = useState<SmtpConfig | null>(null);
  const [form, setForm] = useState<SmtpConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      '/v1/interface/smtp/',
      (response) => {
        const cfg = (response?.data?.config || {}) as SmtpConfig;
        setConfig(cfg);
        setForm({ ...cfg });
        setLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not load SMTP config: ${reason}`);
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (field: keyof SmtpConfig) => (event) =>
    setForm((prev) => ({ ...prev, [field]: event.target.value }));

  const save = () => {
    setSaving(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/interface/smtp/',
      { ...form },
      () => {
        showSuccessBar(enqueueSnackbar, 'SMTP config saved.');
        load();
        setSaving(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not save SMTP config: ${reason}`);
        setSaving(false);
      },
    );
  };

  const runTest = () => {
    setTesting(true);
    setTestResult(null);
    // Send the unsaved form values so a test can validate them before saving.
    void axiosConfig.perform_post(
      auth,
      '/v1/interface/smtp/test/',
      { ...form },
      (response) => {
        setTestResult((response?.data?.test || {}) as TestResult);
        setTesting(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        setTestResult({
          ok: false,
          steps: [],
          error: `Request failed: ${reason}`,
        });
        setTesting(false);
      },
    );
  };

  if (loading) {
    return (
      <Card className="border-0 shadow-sm p-2">
        <Card.Body className="d-flex gap-2 text-muted py-4">
          <Spinner size="sm" animation="border" /> Loading SMTP config...
        </Card.Body>
      </Card>
    );
  }

  return (
    <Card className="border-0 shadow-sm p-2">
      <Card.Body>
        <h5 className="mb-1">SMTP Server</h5>
        <p className="text-muted small">
          Used for alarm / report mails. Leave the password empty or unchanged
          ({PASSWORD_MASK}) to keep the stored one.
        </p>
        <Row className="g-3">
          <Col md={6}>
            <Form.Label className="small text-muted">Sender</Form.Label>
            <Form.Control
              size="sm"
              placeholder="Mess-Server <kontakt@progeo.com>"
              value={form.sender ?? ''}
              onChange={set('sender')}
            />
          </Col>
          <Col md={6}>
            <Form.Label className="small text-muted">Reply-To</Form.Label>
            <Form.Control
              size="sm"
              value={form.reply_to ?? ''}
              onChange={set('reply_to')}
            />
          </Col>
          <Col md={5}>
            <Form.Label className="small text-muted">Server</Form.Label>
            <Form.Control
              size="sm"
              placeholder="smtp.progeo.com"
              value={form.server ?? ''}
              onChange={set('server')}
            />
          </Col>
          <Col md={2}>
            <Form.Label className="small text-muted">Port</Form.Label>
            <Form.Control
              size="sm"
              type="number"
              value={form.port ?? 587}
              onChange={set('port')}
            />
          </Col>
          <Col md={3}>
            <Form.Label className="small text-muted">Username</Form.Label>
            <Form.Control
              size="sm"
              value={form.username ?? ''}
              onChange={set('username')}
            />
          </Col>
          <Col md={2}>
            <Form.Label className="small text-muted">Password</Form.Label>
            <Form.Control
              size="sm"
              type="password"
              placeholder={config?.password ? PASSWORD_MASK : ''}
              value={form.password ?? ''}
              onChange={set('password')}
            />
          </Col>
        </Row>
        <div className="d-flex gap-2 align-items-center mt-3">
          <Button
            size="sm"
            variant="primary"
            onClick={save}
            disabled={saving || testing}
          >
            {saving ? 'Saving…' : 'Save SMTP config'}
          </Button>
          <Button
            size="sm"
            variant="outline-secondary"
            onClick={runTest}
            disabled={testing || saving}
            title="Connects to the server, checks TLS and login. No mail is sent."
          >
            {testing ? (
              <>
                <Spinner size="sm" animation="border" className="me-1" />
                Testing…
              </>
            ) : (
              'Test connection'
            )}
          </Button>
        </div>
        <TestFeedback result={testResult} />
      </Card.Body>
    </Card>
  );
};

const ModbusConfigCard = () => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [form, setForm] = useState<ModbusConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      '/v1/interface/modbus/',
      (response) => {
        setForm((response?.data?.config || {}) as ModbusConfig);
        setLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not load Modbus config: ${reason}`);
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar]);

  useEffect(() => {
    load();
  }, [load]);

  const setNum = (field: keyof ModbusConfig) => (event) =>
    setForm((prev) => ({
      ...prev,
      [field]: Number(event.target.value),
    }));

  const save = () => {
    setSaving(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/interface/modbus/',
      { ...form },
      () => {
        showSuccessBar(enqueueSnackbar, 'Modbus config saved.');
        load();
        setSaving(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not save Modbus config: ${reason}`);
        setSaving(false);
      },
    );
  };

  const runTest = () => {
    setTesting(true);
    setTestResult(null);
    // Send the unsaved form values so a test can validate them before saving.
    void axiosConfig.perform_post(
      auth,
      '/v1/interface/modbus/test/',
      { ...form },
      (response) => {
        setTestResult((response?.data?.test || {}) as TestResult);
        setTesting(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        setTestResult({
          ok: false,
          steps: [],
          error: `Request failed: ${reason}`,
        });
        setTesting(false);
      },
    );
  };

  if (loading) {
    return (
      <Card className="border-0 shadow-sm p-2">
        <Card.Body className="d-flex gap-2 text-muted py-4">
          <Spinner size="sm" animation="border" /> Loading Modbus config...
        </Card.Body>
      </Card>
    );
  }

  return (
    <Card className="border-0 shadow-sm p-2">
      <Card.Body>
        <h5 className="mb-1">Modbus TCP</h5>
        <p className="text-muted small">
          Connection used for device communication via Modbus TCP.
        </p>
        <Row className="g-3">
          <Col md={4}>
            <Form.Label className="small text-muted">Host</Form.Label>
            <Form.Control
              size="sm"
              placeholder="127.0.0.1"
              value={form.host ?? ''}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, host: event.target.value }))
              }
            />
          </Col>
          <Col md={2}>
            <Form.Label className="small text-muted">Port</Form.Label>
            <Form.Control
              size="sm"
              type="number"
              value={form.port ?? 502}
              onChange={setNum('port')}
            />
          </Col>
          <Col md={2}>
            <Form.Label className="small text-muted">Unit ID</Form.Label>
            <Form.Control
              size="sm"
              type="number"
              value={form.unit_id ?? 1}
              onChange={setNum('unit_id')}
            />
          </Col>
          <Col md={2}>
            <Form.Label className="small text-muted">Timeout (s)</Form.Label>
            <Form.Control
              size="sm"
              type="number"
              value={form.timeout ?? 3}
              onChange={setNum('timeout')}
            />
          </Col>
          <Col md={2}>
            <Form.Label className="small text-muted">Start address</Form.Label>
            <Form.Control
              size="sm"
              type="number"
              value={form.start_address ?? 0}
              onChange={setNum('start_address')}
            />
          </Col>
        </Row>
        <div className="d-flex gap-2 align-items-center mt-3">
          <Button
            size="sm"
            variant="primary"
            onClick={save}
            disabled={saving || testing}
          >
            {saving ? 'Saving…' : 'Save Modbus config'}
          </Button>
          <Button
            size="sm"
            variant="outline-secondary"
            onClick={runTest}
            disabled={testing || saving}
            title="Connects to the server and reads the register at the start address. Nothing is written."
          >
            {testing ? (
              <>
                <Spinner size="sm" animation="border" className="me-1" />
                Testing…
              </>
            ) : (
              'Test connection'
            )}
          </Button>
        </div>
        <TestFeedback result={testResult} />
      </Card.Body>
    </Card>
  );
};

export default LocationInterfaceTab;
