import { useState } from 'react';
import { Alert, Button, Col, Form, Row, Spinner, Table } from 'react-bootstrap';
import { CheckCircle, PlusCircle } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { showErrorBar, showRequestError, showSuccessBar } from '../ui/Snackbar.jsx';
import PanelCard from '../ui/kit/PanelCard';

type AirtableProject = {
  project_id: number;
  name: string | null;
  airtable_type: string;
  project_type_label: string;
  product_sheets: string[];
  airtable_url: string | null;
  raw_address: string;
};

export type AirtableSync = {
  available: AirtableProject[];
  updated: { id: number; project_id: number; name: string; fields: string[] }[];
  unchanged: number;
  signed: string;
  accounts: { id: number; name: string }[];
};

/**
 * Result of "Sync with Airtable" (staff, device overview): the projects in
 * "Messeinheit und Inbetriebnahme" without a location can be created under
 * an account; the existing locations were merge-updated by the sync
 * (helper/airtable_locations.py). `onLocationsChanged`: names changed or
 * locations were created - the overview reloads its location list.
 */
const AirtableSyncPanel = ({
  initial,
  onClose,
  onLocationsChanged,
}: {
  initial: AirtableSync;
  onClose: () => void;
  onLocationsChanged: () => void;
}) => {
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [airtable, setAirtable] = useState<AirtableSync>(initial);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importAccount, setImportAccount] = useState('');
  const [importing, setImporting] = useState(false);

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

  const toggleAllProjects = () =>
    setSelected(
      selected.size === airtable.available.length
        ? new Set()
        : new Set(airtable.available.map((project) => project.project_id)),
    );

  const importProjects = () => {
    if (!selected.size) {
      return;
    }
    if (!importAccount) {
      showErrorBar(enqueueSnackbar, 'Please select an account first.');
      return;
    }
    setImporting(true);
    void axiosConfig.perform_post(
      auth,
      '/v1/device/provision/airtable/import/',
      { signed: airtable.signed, account: Number(importAccount), project_ids: Array.from(selected) },
      (response) => {
        const created = (response?.data?.created || []) as { project_id: number }[];
        const skipped = (response?.data?.skipped || []) as number[];
        const done = new Set([...created.map((location) => location.project_id), ...skipped]);
        setAirtable({ ...airtable, available: airtable.available.filter((project) => !done.has(project.project_id)) });
        setSelected(new Set());
        setImporting(false);
        showSuccessBar(
          enqueueSnackbar,
          `${created.length} location(s) created` + (skipped.length ? `, ${skipped.length} existed already.` : '.'),
        );
        onLocationsChanged();
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not create locations', error);
        setImporting(false);
      },
    );
  };

  return (
    <PanelCard
      title='Airtable projects in "Messeinheit und Inbetriebnahme"'
      actions={
        <Button variant="link" size="sm" className="p-0" onClick={onClose}>
          Close
        </Button>
      }
    >
      <small className="text-muted d-block mb-3">
        {airtable.updated.length} existing location(s) updated, {airtable.unchanged} already up to date.{' '}
        {airtable.available.length} project(s) without a location.
      </small>

      {airtable.updated.length > 0 && (
        <Alert variant="info" className="small">
          Updated:{' '}
          {airtable.updated.map((location) => `${location.project_id} (${location.fields.join(', ')})`).join('; ')}
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
                      <small className="d-block text-muted">{project.product_sheets.join(', ')}</small>
                    )}
                  </td>
                  <td className="small text-muted" style={{ whiteSpace: 'pre-line' }}>
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
              <Form.Label className="text-muted small mb-1">Account of the new locations</Form.Label>
              <Form.Select value={importAccount} onChange={(event) => setImportAccount(event.target.value)}>
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
                disabled={importing || !selected.size || !importAccount}
              >
                {importing ? (
                  <Spinner size="sm" animation="border" className="me-2" />
                ) : (
                  <PlusCircle className="me-2" />
                )}
                Create {selected.size || ''} location(s)
              </Button>
            </Col>
          </Row>
        </>
      )}
    </PanelCard>
  );
};

export default AirtableSyncPanel;
