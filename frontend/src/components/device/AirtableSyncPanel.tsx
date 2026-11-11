import { useMemo, useState } from 'react';
import { Alert, Button, Col, Form, Row, Spinner } from 'react-bootstrap';
import { CheckCircle, PlusCircle } from 'react-bootstrap-icons';
import { useSnackbar } from 'notistack';
import { useAuth } from '../../../hooks/CoreAuthProvider';
import axiosConfig from '../../axiosConfig';
import { showErrorBar, showRequestError, showSuccessBar } from '../ui/Snackbar.jsx';
import PanelCard from '../ui/kit/PanelCard';
import SearchableDataTable, { ROW_CLICK, type SearchableColumn } from '../ui/kit/SearchableDataTable';

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

/** Account preselected for the new locations: the main account. */
const DEFAULT_IMPORT_ACCOUNT = 1;

/** Text order with numbers in their natural order, empty values last
 * (DataTable reverses it for descending). */
const byText = (pick: (project: AirtableProject) => string) => (a: AirtableProject, b: AirtableProject) => {
  const left = pick(a);
  const right = pick(b);
  if (!left || !right) {
    return !left && !right ? 0 : !left ? 1 : -1;
  }
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
};

const typeText = (project: AirtableProject) => [project.project_type_label, ...project.product_sheets].join(' ');

const projectKey = (project: AirtableProject) => project.project_id;

const COLUMNS: SearchableColumn<AirtableProject>[] = [
  {
    id: 'project_id',
    name: 'Project ID',
    selector: (project) => project.project_id,
    sortable: true,
    sortFunction: (a, b) => a.project_id - b.project_id,
    cell: (project) => <code {...ROW_CLICK}>{project.project_id}</code>,
    width: '110px',
  },
  {
    id: 'name',
    name: 'Name',
    selector: (project) => project.name ?? '',
    sortable: true,
    sortFunction: byText((project) => project.name ?? ''),
    cell: (project) => <span {...ROW_CLICK}>{project.name || '-'}</span>,
    wrap: true,
    grow: 1.5,
  },
  {
    id: 'type',
    name: 'Type',
    selector: typeText,
    sortable: true,
    sortFunction: byText(typeText),
    // The product sheets are part of the cell, so they are searchable too.
    searchText: typeText,
    cell: (project) => (
      <div {...ROW_CLICK}>
        {project.project_type_label}
        {project.product_sheets.length > 0 && (
          <small {...ROW_CLICK} className="d-block text-muted">
            {project.product_sheets.join(', ')}
          </small>
        )}
      </div>
    ),
    wrap: true,
    grow: 1.5,
  },
  {
    id: 'address',
    name: 'Address',
    selector: (project) => project.raw_address,
    sortable: true,
    sortFunction: byText((project) => project.raw_address),
    cell: (project) => (
      <div {...ROW_CLICK} className="small text-muted" style={{ whiteSpace: 'pre-line', padding: '4px 0' }}>
        {project.raw_address || '-'}
      </div>
    ),
    grow: 2,
  },
  {
    id: 'airtable',
    name: '',
    cell: (project) =>
      project.airtable_url && (
        <a href={project.airtable_url} target="_blank" rel="noreferrer">
          Airtable
        </a>
      ),
    // Opening the link must not toggle the row.
    ignoreRowClick: true,
    width: '90px',
  },
];

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
  // New locations go to the main account (pk 1) unless another one is picked.
  const [importAccount, setImportAccount] = useState(() =>
    initial.accounts.some((account) => account.id === DEFAULT_IMPORT_ACCOUNT) ? String(DEFAULT_IMPORT_ACCOUNT) : '',
  );
  const [importing, setImporting] = useState(false);

  // Selection is kept by project ID, so it survives sorting and the search;
  // "select all" (re)selects the rows the search shows.
  const selection = useMemo(() => ({ rowKey: projectKey, selected, onChange: setSelected }), [selected]);

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
          <SearchableDataTable
            columns={COLUMNS}
            data={airtable.available}
            keyField="project_id"
            defaultSortFieldId="project_id"
            selection={selection}
            highlightOnHover
            dense
          />
          <Row className="g-2 align-items-end mt-2">
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
