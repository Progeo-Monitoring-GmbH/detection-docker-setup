import { useState } from 'react';
import { Button, Card, Container, Form, Spinner } from 'react-bootstrap';
import { CloudArrowDown, FileEarmarkText } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { showErrorBar } from '../components/ui/Snackbar.jsx';

type LegacyImportReport = {
  project_id?: number | null;
  url?: string | null;
  fetched?: boolean;
  status_code?: number | null;
  bytes?: number;
  lines?: number;
  parsed?: number;
  created?: number;
  skipped_duplicates?: number;
  errors?: string[];
};

const formatBytes = (bytes: number | undefined | null): string => {
  if (bytes == null) {
    return '-';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const value = Number(bytes);
  for (const unit of ['KB', 'MB', 'GB']) {
    if (value < 1024 * 1024) {
      return `${(value / 1024).toFixed(1)} ${unit}`;
    }
  }
  return `${(value / 1024 / 1024).toFixed(1)} GB`;
};

const LegacyImportView = () => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();

  const [projectId, setProjectId] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<LegacyImportReport | null>(null);

  const fetchProject = () => {
    const pid = projectId.trim();
    if (!pid) {
      showErrorBar(enqueueSnackbar, 'Please enter a project_id first.');
      return;
    }

    setLoading(true);
    setReport(null);
    void axiosConfig.perform_post(
      auth,
      '/v1/device/legacy/fetch/',
      { project_id: Number(pid), dry_run: dryRun },
      (response) => {
        setReport(
          (response?.data?.report || null) as LegacyImportReport | null,
        );
        setLoading(false);
      },
      (error) => {
        const reason = error?.response?.data?.reason || error.message;
        showErrorBar(enqueueSnackbar, `Could not fetch legacy data: ${reason}`);
        setLoading(false);
      },
    );
  };

  return (
    <Container fluid className="py-4">
      <div className="mb-3">
        <h2 className="mb-0">Legacy Data Import</h2>
        <small className="text-muted">
          Fetches <code>https://data-progeo.net/gprs{'{project_id}'}.txt</code>,
          parses its measurements and imports them — entries are only created
          when no measurement exists for the same project and datetime.
        </small>
      </div>

      <Card className="border-0 shadow-sm mb-3 p-3">
        <Card.Body>
          <div className="d-flex flex-wrap align-items-end gap-3">
            <Form.Group>
              <Form.Label className="text-muted small mb-1">
                Project ID
              </Form.Label>
              <Form.Control
                type="number"
                min={1}
                placeholder="e.g. 4304"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    fetchProject();
                  }
                }}
                style={{ width: 180 }}
              />
            </Form.Group>
            <Form.Check
              type="switch"
              id="legacy-dry-run"
              label="Dry run (parse only, don't save)"
              checked={dryRun}
              onChange={(event) => setDryRun(event.target.checked)}
            />
            <Button
              variant="primary"
              onClick={fetchProject}
              disabled={loading || !projectId.trim()}
            >
              {loading ? (
                <>
                  <Spinner size="sm" animation="border" className="me-2" />
                  Fetching...
                </>
              ) : (
                <>
                  <CloudArrowDown className="me-2" />
                  Fetch & Import
                </>
              )}
            </Button>
          </div>
        </Card.Body>
      </Card>

      {report && (
        <Card className="border-0 shadow-sm p-3">
          <Card.Body>
            <h5 className="mb-3">
              <FileEarmarkText className="me-2 text-primary" />
              Import report
            </h5>

            {report.fetched ? (
              <dl className="row mb-2">
                <dt className="col-sm-3">URL</dt>
                <dd className="col-sm-9 text-break">{report.url || '-'}</dd>
                <dt className="col-sm-3">Size</dt>
                <dd className="col-sm-9">{formatBytes(report.bytes)}</dd>
                <dt className="col-sm-3">Lines</dt>
                <dd className="col-sm-9">{report.lines ?? 0}</dd>
                <dt className="col-sm-3">Parsed measurements</dt>
                <dd className="col-sm-9">{report.parsed ?? 0}</dd>
                <dt className="col-sm-3">Created</dt>
                <dd className="col-sm-9">
                  <span className="text-success fw-semibold">
                    {report.created ?? 0}
                  </span>
                </dd>
                <dt className="col-sm-3">Skipped (duplicates)</dt>
                <dd className="col-sm-9">{report.skipped_duplicates ?? 0}</dd>
              </dl>
            ) : (
              <div className="text-muted">
                The file could not be fetched
                {report.status_code != null
                  ? ` (HTTP ${report.status_code})`
                  : ''}
                .
              </div>
            )}

            {Array.isArray(report.errors) && report.errors.length > 0 && (
              <div className="mt-2">
                <div className="text-danger small fw-semibold mb-1">
                  {report.errors.length} issue(s):
                </div>
                <ul className="text-danger small mb-0 ps-3">
                  {report.errors.slice(0, 10).map((error, index) => (
                    <li key={index}>{error}</li>
                  ))}
                  {report.errors.length > 10 && <li>… and more</li>}
                </ul>
              </div>
            )}

            {dryRun && (
              <div className="text-muted small mt-2">
                Dry run — nothing was saved.
              </div>
            )}
          </Card.Body>
        </Card>
      )}
    </Container>
  );
};

export default LegacyImportView;
