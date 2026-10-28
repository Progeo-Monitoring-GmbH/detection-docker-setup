import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Container,
  Form,
  Row,
  Spinner,
  Table,
} from 'react-bootstrap';
import {
  ArrowRepeat,
  CheckCircle,
  Clipboard,
  Download,
  FileEarmarkCode,
  PlusCircle,
} from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import {
  showErrorBar,
  showRequestError,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';

type ProvisionLocation = {
  id: number;
  project_id: number;
  name: string | null;
  project_type: string;
};

type Option = { value: number; label: string };

type ProvisionSettings = {
  sensors: string;
  interval_sec: string;
  pulldown_resistance: string;
  protective_earth: boolean;
  wifi_ssid: string;
  wifi_pwd: string;
};

type QrCode = {
  payload: string;
  image: string;
};

type ProvisionPreview = {
  device_hash: string;
  project_id: number;
  token: string;
  url: string;
  config: string;
  signed: string;
  portal: {
    wifi: QrCode & { ssid: string };
    frontend: QrCode & { url: string };
  };
};

type AirtableProject = {
  project_id: number;
  name: string | null;
  airtable_type: string;
  project_type_label: string;
  product_sheets: string[];
  airtable_url: string | null;
  raw_address: string;
};

type AirtableSync = {
  available: AirtableProject[];
  updated: { id: number; project_id: number; name: string; fields: string[] }[];
  unchanged: number;
  signed: string;
  accounts: { id: number; name: string }[];
};

const EMPTY_SETTINGS: ProvisionSettings = {
  sensors: '32',
  interval_sec: '180',
  pulldown_resistance: '136',
  protective_earth: false,
  wifi_ssid: '',
  wifi_pwd: '',
};

/**
 * Provisioning of a new smartex mx controller (staff or
 * module_devices_provision): pick the location, set the measurement
 * settings, generate the config (device_hash + transfer token are created
 * by the backend) and confirm - the device is then filed under the location
 * and can send its samples.
 *
 * Staff can sync with Airtable: the projects in "Messeinheit und
 * Inbetriebnahme" without a location are listed to be created, the existing
 * locations are merge-updated (helper/airtable_locations.py).
 */
const DeviceProvisionView = () => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();

  const [locations, setLocations] = useState<ProvisionLocation[]>([]);
  const [resistances, setResistances] = useState<Option[]>([]);
  const [locationId, setLocationId] = useState('');
  const [settings, setSettings] = useState<ProvisionSettings>(EMPTY_SETTINGS);
  const [preview, setPreview] = useState<ProvisionPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [airtable, setAirtable] = useState<AirtableSync | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importAccount, setImportAccount] = useState('');
  const [syncing, setSyncing] = useState(false);

  const user = auth?.user as
    { is_staff?: boolean; is_superuser?: boolean } | null | undefined;
  const isStaff = Boolean(user?.is_staff || user?.is_superuser);

  const loadLocations = () => {
    void axiosConfig.perform_get(
      auth,
      '/v1/device/provision/locations/',
      (response) => {
        const data = response?.data || {};
        setLocations((data.locations || []) as ProvisionLocation[]);
        setResistances((data.pulldown_resistances || []) as Option[]);
        const defaults = data.defaults || {};
        setSettings((current) => ({
          ...current,
          sensors: String(defaults.sensors ?? current.sensors),
          interval_sec: String(defaults.interval_sec ?? current.interval_sec),
          pulldown_resistance: String(
            defaults.pulldown_resistance ?? current.pulldown_resistance,
          ),
        }));
      },
      (error) =>
        showRequestError(enqueueSnackbar, 'Could not load locations', error),
    );
  };

  useEffect(() => {
    loadLocations();
    // Once - auth changes with the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any change makes the generated config stale - generate it again.
  const resetPreview = () => {
    setPreview(null);
    setConfirmed(false);
  };

  const updateSetting = <K extends keyof ProvisionSettings>(
    key: K,
    value: ProvisionSettings[K],
  ) => {
    setSettings((current) => ({ ...current, [key]: value }));
    resetPreview();
  };

  const generate = () => {
    if (!locationId) {
      showErrorBar(enqueueSnackbar, 'Please select a project first.');
      return;
    }
    setLoading(true);
    resetPreview();
    void axiosConfig.perform_post(
      auth,
      '/v1/device/provision/preview/',
      {
        location: Number(locationId),
        sensors: Number(settings.sensors),
        interval_sec: Number(settings.interval_sec),
        pulldown_resistance: Number(settings.pulldown_resistance),
        protective_earth: settings.protective_earth ? 1 : 0,
        wifi_ssid: settings.wifi_ssid,
        wifi_pwd: settings.wifi_pwd,
      },
      (response) => {
        setPreview((response?.data || null) as ProvisionPreview | null);
        setLoading(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not generate config', error);
        setLoading(false);
      },
    );
  };

  const confirm = () => {
    if (!preview) {
      return;
    }
    setLoading(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/device/provision/confirm/',
      { signed: preview.signed },
      () => {
        setConfirmed(true);
        setLoading(false);
        showSuccessBar(
          enqueueSnackbar,
          `Device ${preview.device_hash} created.`,
        );
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not create device', error);
        setLoading(false);
      },
    );
  };

  const syncAirtable = () => {
    setSyncing(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/device/provision/airtable/sync/',
      {},
      (response) => {
        const data = (response?.data || null) as AirtableSync | null;
        setAirtable(data);
        setSelected(new Set());
        setSyncing(false);
        if (data?.updated.length) {
          // Names may have changed.
          loadLocations();
        }
      },
      (error) => {
        showRequestError(
          enqueueSnackbar,
          'Could not sync with Airtable',
          error,
        );
        setSyncing(false);
      },
    );
  };

  const toggleProject = (projectId: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  const toggleAllProjects = () => {
    if (!airtable) {
      return;
    }
    setSelected(
      selected.size === airtable.available.length
        ? new Set()
        : new Set(airtable.available.map((project) => project.project_id)),
    );
  };

  const importProjects = () => {
    if (!airtable || !selected.size) {
      return;
    }
    if (!importAccount) {
      showErrorBar(enqueueSnackbar, 'Please select an account first.');
      return;
    }
    setSyncing(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/device/provision/airtable/import/',
      {
        signed: airtable.signed,
        account: Number(importAccount),
        project_ids: Array.from(selected),
      },
      (response) => {
        const created = (response?.data?.created || []) as {
          project_id: number;
        }[];
        const skipped = (response?.data?.skipped || []) as number[];
        const done = new Set([
          ...created.map((location) => location.project_id),
          ...skipped,
        ]);
        setAirtable({
          ...airtable,
          available: airtable.available.filter(
            (project) => !done.has(project.project_id),
          ),
        });
        setSelected(new Set());
        setSyncing(false);
        showSuccessBar(
          enqueueSnackbar,
          `${created.length} location(s) created` +
            (skipped.length ? `, ${skipped.length} existed already.` : '.'),
        );
        loadLocations();
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not create locations', error);
        setSyncing(false);
      },
    );
  };

  const copyConfig = () => {
    if (!preview) {
      return;
    }
    navigator.clipboard
      .writeText(preview.config)
      .then(() => showSuccessBar(enqueueSnackbar, 'Config copied.'))
      .catch(() => showErrorBar(enqueueSnackbar, 'Could not copy the config.'));
  };

  const downloadConfig = () => {
    if (!preview) {
      return;
    }
    const url = URL.createObjectURL(
      new Blob([preview.config], { type: 'text/plain' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `device_config_${preview.device_hash}.lua`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const portalQrCode = (title: string, caption: string, code: QrCode) => (
    <figure className="m-0 text-center">
      <img
        src={code.image}
        alt={title}
        width={180}
        height={180}
        style={{ imageRendering: 'pixelated' }}
      />
      <figcaption className="small">
        <strong>{title}</strong>
        <br />
        <code>{caption}</code>
      </figcaption>
    </figure>
  );

  const selectedLocation = locations.find(
    (location) => String(location.id) === locationId,
  );

  return (
    <Container fluid className="py-4">
      <div className="mb-3 d-flex flex-wrap justify-content-between align-items-start gap-2">
        <div>
          <h2 className="mb-0">Provision device</h2>
          <small className="text-muted">
            Generates the config of a new smartex mx controller (device hash and
            transfer token included). On confirm the device is created under the
            selected location and can send its data.
          </small>
        </div>
        {isStaff && (
          <Button
            variant="outline-primary"
            onClick={syncAirtable}
            disabled={syncing}
          >
            {syncing && !airtable ? (
              <Spinner size="sm" animation="border" className="me-2" />
            ) : (
              <ArrowRepeat className="me-2" />
            )}
            Sync with Airtable
          </Button>
        )}
      </div>

      {airtable && (
        <Card className="border-0 shadow-sm mb-3 p-3">
          <Card.Body>
            <div className="d-flex justify-content-between align-items-start mb-2">
              <h5 className="mb-0">
                Airtable projects in &quot;Messeinheit und Inbetriebnahme&quot;
              </h5>
              <Button
                variant="link"
                size="sm"
                className="p-0"
                onClick={() => setAirtable(null)}
              >
                Close
              </Button>
            </div>
            <small className="text-muted d-block mb-3">
              {airtable.updated.length} existing location(s) updated,{' '}
              {airtable.unchanged} already up to date.{' '}
              {airtable.available.length} project(s) without a location.
            </small>

            {airtable.updated.length > 0 && (
              <Alert variant="info" className="small">
                Updated:{' '}
                {airtable.updated
                  .map(
                    (location) =>
                      `${location.project_id} (${location.fields.join(', ')})`,
                  )
                  .join('; ')}
              </Alert>
            )}

            {airtable.available.length === 0 ? (
              <Alert variant="success" className="mb-0">
                <CheckCircle className="me-2" />
                Every project has a location.
              </Alert>
            ) : (
              <>
                <Table responsive hover size="sm" className="align-middle">
                  <thead>
                    <tr>
                      <th>
                        <Form.Check
                          aria-label="Select all"
                          checked={selected.size === airtable.available.length}
                          onChange={toggleAllProjects}
                        />
                      </th>
                      <th>Project ID</th>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Address</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {airtable.available.map((project) => (
                      <tr
                        key={project.project_id}
                        onClick={() => toggleProject(project.project_id)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td>
                          <Form.Check
                            aria-label={`Select ${project.project_id}`}
                            checked={selected.has(project.project_id)}
                            onChange={() => toggleProject(project.project_id)}
                            onClick={(event) => event.stopPropagation()}
                          />
                        </td>
                        <td>
                          <code>{project.project_id}</code>
                        </td>
                        <td>{project.name || '-'}</td>
                        <td>
                          {project.project_type_label}
                          {project.product_sheets.length > 0 && (
                            <small className="d-block text-muted">
                              {project.product_sheets.join(', ')}
                            </small>
                          )}
                        </td>
                        <td
                          className="small text-muted"
                          style={{ whiteSpace: 'pre-line' }}
                        >
                          {project.raw_address || '-'}
                        </td>
                        <td>
                          {project.airtable_url && (
                            <a
                              href={project.airtable_url}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(event) => event.stopPropagation()}
                            >
                              Airtable
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Row className="g-2 align-items-end">
                  <Col md={4}>
                    <Form.Label className="text-muted small mb-1">
                      Account of the new locations
                    </Form.Label>
                    <Form.Select
                      value={importAccount}
                      onChange={(event) => setImportAccount(event.target.value)}
                    >
                      <option value="">Select account…</option>
                      {airtable.accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </Form.Select>
                  </Col>
                  <Col md="auto">
                    <Button
                      variant="primary"
                      onClick={importProjects}
                      disabled={syncing || !selected.size || !importAccount}
                    >
                      {syncing ? (
                        <Spinner
                          size="sm"
                          animation="border"
                          className="me-2"
                        />
                      ) : (
                        <PlusCircle className="me-2" />
                      )}
                      Create {selected.size || ''} location(s)
                    </Button>
                  </Col>
                </Row>
              </>
            )}
          </Card.Body>
        </Card>
      )}

      <Card className="border-0 shadow-sm mb-3 p-3">
        <Card.Body>
          <Row className="g-3">
            <Col md={6}>
              <Form.Group>
                <Form.Label className="text-muted small mb-1">
                  Project / location
                </Form.Label>
                <Form.Select
                  value={locationId}
                  onChange={(event) => {
                    setLocationId(event.target.value);
                    resetPreview();
                  }}
                >
                  <option value="">Select project_id…</option>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.project_id} – {location.name || 'Unnamed'} (
                      {location.project_type})
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
            <Col sm={4} md={2}>
              <Form.Group>
                <Form.Label className="text-muted small mb-1">
                  Sensors
                </Form.Label>
                <Form.Control
                  type="number"
                  min={1}
                  max={128}
                  value={settings.sensors}
                  onChange={(event) =>
                    updateSetting('sensors', event.target.value)
                  }
                />
              </Form.Group>
            </Col>
            <Col sm={4} md={2}>
              <Form.Group>
                <Form.Label className="text-muted small mb-1">
                  Interval (sec)
                </Form.Label>
                <Form.Control
                  type="number"
                  min={10}
                  max={86400}
                  value={settings.interval_sec}
                  onChange={(event) =>
                    updateSetting('interval_sec', event.target.value)
                  }
                />
              </Form.Group>
            </Col>
            <Col sm={4} md={2}>
              <Form.Group>
                <Form.Label className="text-muted small mb-1">
                  Pull-down resistance
                </Form.Label>
                <Form.Select
                  value={settings.pulldown_resistance}
                  onChange={(event) =>
                    updateSetting('pulldown_resistance', event.target.value)
                  }
                >
                  {resistances.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} ({option.value})
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            </Col>
            <Col md={4}>
              <Form.Group>
                <Form.Label className="text-muted small mb-1">
                  WiFi SSID (optional)
                </Form.Label>
                <Form.Control
                  value={settings.wifi_ssid}
                  onChange={(event) =>
                    updateSetting('wifi_ssid', event.target.value)
                  }
                />
              </Form.Group>
            </Col>
            <Col md={4}>
              <Form.Group>
                <Form.Label className="text-muted small mb-1">
                  WiFi password (optional)
                </Form.Label>
                <Form.Control
                  type="password"
                  autoComplete="new-password"
                  value={settings.wifi_pwd}
                  onChange={(event) =>
                    updateSetting('wifi_pwd', event.target.value)
                  }
                />
              </Form.Group>
            </Col>
            <Col md={4} className="d-flex align-items-end">
              <Form.Check
                type="switch"
                id="provision-protective-earth"
                label="Protective earth"
                checked={settings.protective_earth}
                onChange={(event) =>
                  updateSetting('protective_earth', event.target.checked)
                }
              />
            </Col>
          </Row>
          <div className="mt-3">
            <Button
              variant="primary"
              onClick={generate}
              disabled={loading || !locationId}
            >
              {loading && !preview ? (
                <Spinner size="sm" animation="border" className="me-2" />
              ) : (
                <FileEarmarkCode className="me-2" />
              )}
              Generate config
            </Button>
          </div>
        </Card.Body>
      </Card>

      {preview && (
        <Card className="border-0 shadow-sm p-3">
          <Card.Body>
            <dl className="row mb-3">
              <dt className="col-sm-2">Device hash</dt>
              <dd className="col-sm-10">
                <code>{preview.device_hash}</code>
              </dd>
              <dt className="col-sm-2">Location</dt>
              <dd className="col-sm-10">
                {selectedLocation?.name || '-'} (project {preview.project_id})
              </dd>
              <dt className="col-sm-2">URL</dt>
              <dd className="col-sm-10 text-break">
                <code>{preview.url}</code>
              </dd>
              <dt className="col-sm-2">Token</dt>
              <dd className="col-sm-10">
                <code>{preview.token}</code>
              </dd>
            </dl>

            <Row className="g-3 mb-3">
              <Col lg={8}>
                <Form.Control
                  as="textarea"
                  readOnly
                  rows={36}
                  value={preview.config}
                  className="font-monospace small"
                  onFocus={(event) => event.target.select()}
                />
              </Col>
              <Col lg={4}>
                <div className="d-flex flex-wrap flex-lg-column align-items-center gap-4">
                  {portalQrCode(
                    'Setup portal Wi-Fi',
                    preview.portal.wifi.ssid,
                    preview.portal.wifi,
                  )}
                  {portalQrCode(
                    'Controller',
                    preview.portal.frontend.url,
                    preview.portal.frontend,
                  )}
                </div>
              </Col>
            </Row>

            {confirmed ? (
              <Alert variant="success" className="mb-3">
                <CheckCircle className="me-2" />
                Device <code>{preview.device_hash}</code> is created and linked
                to its location - it is ready to send its data.
              </Alert>
            ) : (
              <Alert variant="warning" className="mb-3">
                Nothing is saved yet: the token only works once you confirm.
              </Alert>
            )}

            <div className="d-flex flex-wrap gap-2">
              <Button variant="outline-secondary" onClick={copyConfig}>
                <Clipboard className="me-2" />
                Copy
              </Button>
              <Button variant="outline-secondary" onClick={downloadConfig}>
                <Download className="me-2" />
                Download
              </Button>
              <Button
                variant="success"
                onClick={confirm}
                disabled={loading || confirmed}
              >
                {loading ? (
                  <Spinner size="sm" animation="border" className="me-2" />
                ) : (
                  <CheckCircle className="me-2" />
                )}
                Confirm
              </Button>
            </div>
          </Card.Body>
        </Card>
      )}
    </Container>
  );
};

export default DeviceProvisionView;
