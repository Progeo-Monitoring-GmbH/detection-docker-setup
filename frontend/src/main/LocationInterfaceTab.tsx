import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Card, Col, Form, Row, Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import usePermissions from '../../hooks/usePermissions';
import axiosConfig from '../axiosConfig';
import { errorReason, showErrorBar, showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';

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

type EsendexConfig = {
  account_reference?: string;
  username?: string;
  password?: string;
  from?: string;
};

type MessengerService = 'signal' | 'whatsapp' | 'matrix';

type MessengerConfig = Record<string, string | undefined>;

type MessengerField = {
  key: string;
  label: string;
  placeholder?: string;
  /** Masked by the backend; empty/unchanged keeps the stored value. */
  secret?: boolean;
  md: number;
};

/** The three messenger gateways (helper/messenger.py) - one card each. */
const MESSENGER_CARDS: Record<
  MessengerService,
  { title: string; description: ReactNode; fields: MessengerField[]; toPlaceholder: string }
> = {
  signal: {
    title: 'Signal',
    description: (
      <>
        Sends through the <code>progeo-signal</code> container (compose
        profile <code>messenger</code>) with a registered or linked sender
        number. Falls back to the <code>SIGNAL_*</code> env vars until saved.
      </>
    ),
    fields: [
      { key: 'api_url', label: 'API URL', placeholder: 'http://progeo-signal:8080', md: 6 },
      { key: 'number', label: 'Sender number', placeholder: '+49 151 2345678', md: 6 },
    ],
    toPlaceholder: '+49 151 2345678',
  },
  whatsapp: {
    title: 'WhatsApp',
    description: (
      <>
        WhatsApp Business Cloud API (Meta). Messages the business starts are
        only delivered as approved templates: set a template with one body
        parameter <code>{'{{1}}'}</code> (the notification text). Without a
        template, messages only arrive within 24h after the user last wrote
        to the business number. Env fallback: <code>WHATSAPP_*</code>.
      </>
    ),
    fields: [
      { key: 'phone_number_id', label: 'Phone number ID', md: 6 },
      { key: 'access_token', label: 'Access token', secret: true, md: 6 },
      { key: 'template', label: 'Template name', placeholder: 'progeo_alarm', md: 4 },
      { key: 'template_language', label: 'Template language', placeholder: 'de', md: 4 },
      { key: 'api_version', label: 'Graph API version', placeholder: 'v21.0', md: 4 },
    ],
    toPlaceholder: '+49 151 2345678',
  },
  matrix: {
    title: 'Matrix',
    description: (
      <>
        A bot account on a Matrix homeserver – our own runs in the compose
        profile <code>messenger</code> (<code>http://progeo-matrix:8008</code>).
        Each user gets a direct room on
        the first message and has to accept the invite. Messages are not
        end-to-end encrypted. Env fallback: <code>MATRIX_*</code>.
      </>
    ),
    fields: [
      { key: 'homeserver', label: 'Homeserver', placeholder: 'http://progeo-matrix:8008', md: 6 },
      { key: 'access_token', label: 'Bot access token', secret: true, md: 6 },
    ],
    toPlaceholder: '@name:matrix.progeo.com',
  },
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

type InterfaceKind = 'smtp' | 'modbus' | 'sms' | `messenger/${MessengerService}`;

/**
 * Load/save/test plumbing shared by the interface cards: GET/POST
 * /v1/interface/<kind>/ and POST /v1/interface/<kind>/test/ with the
 * (possibly unsaved) form values.
 */
const useInterfaceConfig = <T extends object>(kind: InterfaceKind, label: string) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [config, setConfig] = useState<T | null>(null);
  const [form, setForm] = useState<T>({} as T);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/interface/${kind}/`,
      (response) => {
        const cfg = (response?.data?.config || {}) as T;
        setConfig(cfg);
        setForm({ ...cfg });
        setLoading(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, `Could not load ${label} config`, error);
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar, kind, label]);

  useEffect(() => {
    load();
  }, [load]);

  const save = () => {
    setSaving(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/interface/${kind}/`,
      { ...form },
      () => {
        showSuccessBar(enqueueSnackbar, `${label} config saved.`);
        load();
        setSaving(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, `Could not save ${label} config`, error);
        setSaving(false);
      },
    );
  };

  // Sends the unsaved form values so a test can validate them before saving.
  const runTest = (extra: Record<string, unknown> = {}) => {
    setTesting(true);
    setTestResult(null);
    void axiosConfig.perform_post(
      auth,
      `/v1/interface/${kind}/test/`,
      { ...extra, ...form },
      (response) => {
        setTestResult((response?.data?.test || {}) as TestResult);
        setTesting(false);
      },
      (error) => {
        setTestResult({ ok: false, steps: [], error: `Request failed: ${errorReason(error)}` });
        setTesting(false);
      },
    );
  };

  return { config, form, setForm, loading, saving, save, testing, testResult, setTestResult, runTest };
};

const ConfigLoadingCard = ({ label }: { label: string }) => (
  <Card className="border-0 shadow-sm p-2">
    <Card.Body className="d-flex gap-2 text-muted py-4">
      <Spinner size="sm" animation="border" /> Loading {label} config...
    </Card.Body>
  </Card>
);

const ReadOnlyHint = ({ permission, action = 'zum Bearbeiten' }: { permission: string; action?: string }) => (
  <span className="small text-muted">
    Nur ansehen – {action} fehlt <code>{permission}</code>.
  </span>
);

const BusyLabel = ({ busy, busyText, children }: { busy: boolean; busyText: string; children: string }) =>
  busy ? (
    <>
      <Spinner size="sm" animation="border" className="me-1" />
      {busyText}
    </>
  ) : (
    <>{children}</>
  );

/**
 * Schnittstelle tab: runtime configuration of the SMTP server, the Modbus
 * connection, the Esendex SMS gateway and the messenger gateways (stored in
 * SystemConfig, falls back to django.env until saved). The messenger cards
 * share the SMS permissions - both are text message gateways. Cards are shown according to the granular
 * module_interface_* permissions; the tab itself is hidden by
 * LocationDetailView when module_interface_enabled is missing.
 */
const LocationInterfaceTab = () => {
  const { hasPermission } = usePermissions();
  const cards = [
    hasPermission('module_interface_smtp_enabled') ? <SmtpConfigCard key="smtp" /> : null,
    hasPermission('module_interface_modbus_enabled') ? <ModbusConfigCard key="modbus" /> : null,
    hasPermission('module_interface_sms_enabled') ? <EsendexSmsCard key="sms" /> : null,
    ...(hasPermission('module_interface_sms_enabled')
      ? (Object.keys(MESSENGER_CARDS) as MessengerService[]).map((service) => (
          <MessengerCard key={service} service={service} />
        ))
      : []),
  ].filter(Boolean);

  if (cards.length === 0) {
    return (
      <Card className="border-0 shadow-sm p-2">
        <Card.Body className="text-muted small">
          Für keine Schnittstelle ist der Zugriff freigeschaltet
          (<code>module_interface_smtp_enabled</code> /{' '}
          <code>module_interface_modbus_enabled</code> /{' '}
          <code>module_interface_sms_enabled</code>).
        </Card.Body>
      </Card>
    );
  }

  return <div className="d-flex flex-column gap-4">{cards}</div>;
};

const SmtpConfigCard = () => {
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission('module_interface_smtp_edit');
  const { config, form, setForm, loading, saving, save, testing, testResult, runTest } =
    useInterfaceConfig<SmtpConfig>('smtp', 'SMTP');

  const set = (field: keyof SmtpConfig) => (event) =>
    setForm((prev) => ({ ...prev, [field]: event.target.value }));

  if (loading) {
    return <ConfigLoadingCard label="SMTP" />;
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
              disabled={!canEdit}
            />
          </Col>
          <Col md={6}>
            <Form.Label className="small text-muted">Reply-To</Form.Label>
            <Form.Control
              size="sm"
              value={form.reply_to ?? ''}
              onChange={set('reply_to')}
              disabled={!canEdit}
            />
          </Col>
          <Col md={5}>
            <Form.Label className="small text-muted">Server</Form.Label>
            <Form.Control
              size="sm"
              placeholder="smtp.progeo.com"
              value={form.server ?? ''}
              onChange={set('server')}
              disabled={!canEdit}
            />
          </Col>
          <Col md={2}>
            <Form.Label className="small text-muted">Port</Form.Label>
            <Form.Control
              size="sm"
              type="number"
              value={form.port ?? 587}
              onChange={set('port')}
              disabled={!canEdit}
            />
          </Col>
          <Col md={3}>
            <Form.Label className="small text-muted">Username</Form.Label>
            <Form.Control
              size="sm"
              value={form.username ?? ''}
              onChange={set('username')}
              disabled={!canEdit}
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
              disabled={!canEdit}
            />
          </Col>
        </Row>
        <div className="d-flex gap-2 align-items-center mt-3 flex-wrap">
          {canEdit && (
            <Button
              size="sm"
              variant="primary"
              onClick={save}
              disabled={saving || testing}
            >
              {saving ? 'Saving…' : 'Save SMTP config'}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline-secondary"
            onClick={() => runTest()}
            disabled={testing || saving}
            title="Connects to the server, checks TLS and login. No mail is sent."
          >
            <BusyLabel busy={testing} busyText="Testing…">
              Test connection
            </BusyLabel>
          </Button>
          {!canEdit && <ReadOnlyHint permission="module_interface_smtp_edit" />}
        </div>
        <TestFeedback result={testResult} />
      </Card.Body>
    </Card>
  );
};

const ModbusConfigCard = () => {
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission('module_interface_modbus_edit');
  const { form, setForm, loading, saving, save, testing, testResult, runTest } =
    useInterfaceConfig<ModbusConfig>('modbus', 'Modbus');

  const setNum = (field: keyof ModbusConfig) => (event) =>
    setForm((prev) => ({
      ...prev,
      [field]: Number(event.target.value),
    }));

  if (loading) {
    return <ConfigLoadingCard label="Modbus" />;
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
              disabled={!canEdit}
            />
          </Col>
          <Col md={2}>
            <Form.Label className="small text-muted">Port</Form.Label>
            <Form.Control
              size="sm"
              type="number"
              value={form.port ?? 502}
              onChange={setNum('port')}
              disabled={!canEdit}
            />
          </Col>
          <Col md={2}>
            <Form.Label className="small text-muted">Unit ID</Form.Label>
            <Form.Control
              size="sm"
              type="number"
              value={form.unit_id ?? 1}
              onChange={setNum('unit_id')}
              disabled={!canEdit}
            />
          </Col>
          <Col md={2}>
            <Form.Label className="small text-muted">Timeout (s)</Form.Label>
            <Form.Control
              size="sm"
              type="number"
              value={form.timeout ?? 3}
              onChange={setNum('timeout')}
              disabled={!canEdit}
            />
          </Col>
          <Col md={2}>
            <Form.Label className="small text-muted">Start address</Form.Label>
            <Form.Control
              size="sm"
              type="number"
              value={form.start_address ?? 0}
              onChange={setNum('start_address')}
              disabled={!canEdit}
            />
          </Col>
        </Row>
        <div className="d-flex gap-2 align-items-center mt-3 flex-wrap">
          {canEdit && (
            <Button
              size="sm"
              variant="primary"
              onClick={save}
              disabled={saving || testing}
            >
              {saving ? 'Saving…' : 'Save Modbus config'}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline-secondary"
            onClick={() => runTest()}
            disabled={testing || saving}
            title="Connects to the server and reads the register at the start address. Nothing is written."
          >
            <BusyLabel busy={testing} busyText="Testing…">
              Test connection
            </BusyLabel>
          </Button>
          {!canEdit && <ReadOnlyHint permission="module_interface_modbus_edit" />}
        </div>
        <TestFeedback result={testResult} />
      </Card.Body>
    </Card>
  );
};

/**
 * Esendex SMS gateway: account credentials + a real "send test SMS" button.
 * Requires module_interface_sms_enabled to view the card and
 * module_interface_sms_edit to save or to send the test SMS.
 */
const EsendexSmsCard = () => {
  const { enqueueSnackbar } = useSnackbar();
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission('module_interface_sms_edit');
  const [smsTo, setSmsTo] = useState('');
  const {
    config,
    form,
    setForm,
    loading,
    saving,
    save,
    testing: sending,
    testResult,
    setTestResult,
    runTest,
  } = useInterfaceConfig<EsendexConfig>('sms', 'SMS');

  const set = (field: keyof EsendexConfig) => (event) =>
    setForm((prev) => ({ ...prev, [field]: event.target.value }));

  // Sending a real SMS needs the sms_edit permission.
  const sendTestSms = () => {
    if (!smsTo.trim()) {
      showErrorBar(enqueueSnackbar, 'Enter a recipient phone number first.');
      return;
    }
    runTest({ to: smsTo.trim() });
  };

  if (loading) {
    return <ConfigLoadingCard label="SMS" />;
  }

  return (
    <Card className="border-0 shadow-sm p-2">
      <Card.Body>
        <h5 className="mb-1">SMS (Esendex)</h5>
        <p className="text-muted small">
          Esendex gateway used to send SMS notifications. Credentials can also
          be set via <code>ESENDEX_*</code> env vars until saved here.
        </p>
        <Row className="g-3">
          <Col md={6}>
            <Form.Label className="small text-muted">
              Account reference
            </Form.Label>
            <Form.Control
              size="sm"
              placeholder="EX0000000"
              value={form.account_reference ?? ''}
              onChange={set('account_reference')}
              disabled={!canEdit}
            />
          </Col>
          <Col md={3}>
            <Form.Label className="small text-muted">Username</Form.Label>
            <Form.Control
              size="sm"
              value={form.username ?? ''}
              onChange={set('username')}
              disabled={!canEdit}
            />
          </Col>
          <Col md={3}>
            <Form.Label className="small text-muted">Password</Form.Label>
            <Form.Control
              size="sm"
              type="password"
              placeholder={config?.password ? PASSWORD_MASK : ''}
              value={form.password ?? ''}
              onChange={set('password')}
              disabled={!canEdit}
            />
          </Col>
          <Col md={6}>
            <Form.Label className="small text-muted">From (sender id)</Form.Label>
            <Form.Control
              size="sm"
              placeholder="Progeo"
              value={form.from ?? ''}
              onChange={set('from')}
              disabled={!canEdit}
            />
          </Col>
        </Row>

        <div className="d-flex gap-2 align-items-center mt-3 flex-wrap">
          {canEdit && (
            <Button
              size="sm"
              variant="primary"
              onClick={save}
              disabled={saving || sending}
            >
              {saving ? 'Saving…' : 'Save SMS config'}
            </Button>
          )}
          {!canEdit && (
            <ReadOnlyHint
              permission="module_interface_sms_edit"
              action="zum Bearbeiten und zum Versenden"
            />
          )}
        </div>

        {canEdit && (
          <div className="mt-3 p-3 border rounded bg-light">
            <div className="small fw-semibold mb-2">Send a test SMS</div>
            <div className="d-flex flex-wrap align-items-end gap-2">
              <Form.Control
                size="sm"
                style={{ width: 240 }}
                type="tel"
                placeholder="+49 151 2345678"
                value={smsTo}
                onChange={(event) => {
                  setSmsTo(event.target.value);
                  setTestResult(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    sendTestSms();
                  }
                }}
              />
              <Button
                size="sm"
                variant="success"
                onClick={sendTestSms}
                disabled={sending || saving || !smsTo.trim()}
                title="Sends one real SMS via Esendex (costs one SMS)."
              >
                <BusyLabel busy={sending} busyText="Sending…">
                  Send test SMS
                </BusyLabel>
              </Button>
            </div>
            <div className="small text-muted mt-1">
              Sends a real SMS to the given number using the config above –
              even if it is not saved yet.
            </div>
          </div>
        )}
        <TestFeedback result={testResult} />
      </Card.Body>
    </Card>
  );
};

/**
 * One messenger gateway (Signal / WhatsApp / Matrix): its config + a real
 * "send test message" button. Same permissions as the SMS card.
 */
const MessengerCard = ({ service }: { service: MessengerService }) => {
  const { enqueueSnackbar } = useSnackbar();
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission('module_interface_sms_edit');
  const { title, description, fields, toPlaceholder } = MESSENGER_CARDS[service];
  const [to, setTo] = useState('');
  const {
    config,
    form,
    setForm,
    loading,
    saving,
    save,
    testing: sending,
    testResult,
    setTestResult,
    runTest,
  } = useInterfaceConfig<MessengerConfig>(`messenger/${service}`, title);

  const sendTest = () => {
    if (!to.trim()) {
      showErrorBar(enqueueSnackbar, 'Enter a recipient first.');
      return;
    }
    runTest({ to: to.trim() });
  };

  if (loading) {
    return <ConfigLoadingCard label={title} />;
  }

  return (
    <Card className="border-0 shadow-sm p-2">
      <Card.Body>
        <h5 className="mb-1">Messenger: {title}</h5>
        <p className="text-muted small">{description}</p>
        <Row className="g-3">
          {fields.map((field) => (
            <Col md={field.md} key={field.key}>
              <Form.Label className="small text-muted">{field.label}</Form.Label>
              <Form.Control
                size="sm"
                type={field.secret ? 'password' : 'text'}
                placeholder={field.secret ? (config?.[field.key] ? PASSWORD_MASK : '') : field.placeholder}
                value={form[field.key] ?? ''}
                onChange={(event) => setForm((prev) => ({ ...prev, [field.key]: event.target.value }))}
                disabled={!canEdit}
              />
            </Col>
          ))}
        </Row>

        <div className="d-flex gap-2 align-items-center mt-3 flex-wrap">
          {canEdit && (
            <Button size="sm" variant="primary" onClick={save} disabled={saving || sending}>
              {saving ? 'Saving…' : `Save ${title} config`}
            </Button>
          )}
          {!canEdit && (
            <ReadOnlyHint permission="module_interface_sms_edit" action="zum Bearbeiten und zum Versenden" />
          )}
        </div>

        {canEdit && (
          <div className="mt-3 p-3 border rounded bg-light">
            <div className="small fw-semibold mb-2">Send a test message</div>
            <div className="d-flex flex-wrap align-items-end gap-2">
              <Form.Control
                size="sm"
                style={{ width: 240 }}
                placeholder={toPlaceholder}
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                  setTestResult(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    sendTest();
                  }
                }}
              />
              <Button
                size="sm"
                variant="success"
                onClick={sendTest}
                disabled={sending || saving || !to.trim()}
                title={`Sends one real ${title} message.`}
              >
                <BusyLabel busy={sending} busyText="Sending…">
                  Send test message
                </BusyLabel>
              </Button>
            </div>
            <div className="small text-muted mt-1">
              Uses the config above – even if it is not saved yet.
            </div>
          </div>
        )}
        <TestFeedback result={testResult} />
      </Card.Body>
    </Card>
  );
};

export default LocationInterfaceTab;
