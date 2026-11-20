import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  ButtonGroup,
  Card,
  Form,
  Modal,
  Spinner,
} from 'react-bootstrap';
import { ArrowRepeat, CheckLg, PersonCheck, XLg } from 'react-bootstrap-icons';
import DataTable from 'react-data-table-component';
import type { TableColumn } from 'react-data-table-component';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import {
  errorReason,
  showInfoBar,
  showRequestError,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import { useMobileColumns } from '../components/ui/kit/mobileTable';
import { repeatedTestId } from '../testIds';
import BadgePicker from '../components/ui/kit/BadgePicker';

type AccessRequestStatus =
  'unverified' | 'pending' | 'approved' | 'rejected';

type AccessRequest = {
  id: number;
  status: AccessRequestStatus;
  first_name: string;
  last_name: string;
  company: string;
  email: string;
  phone: string;
  project: string;
  message: string;
  created: string | null;
  verified_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string;
  user_id: number | null;
  /** Preselected mail language: the form's, else German. */
  language?: 'de' | 'en';
};

const STATUS_VARIANT: Record<AccessRequestStatus, string> = {
  unverified: 'secondary',
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
};

// Pending first - those are the ones waiting for a decision.
const STATUS_ORDER: Record<AccessRequestStatus, number> = {
  pending: 0,
  unverified: 1,
  approved: 2,
  rejected: 3,
};

type Decision = { request: AccessRequest; action: 'approve' | 'reject' };

/** A project of the project search (/v1/location/project-search/) - or just
 * a number typed in (then without names: checked on approval). */
export type ProjectChoice = {
  project_id: number;
  names?: string[];
  cities?: string[];
  accounts?: string[];
  locations?: number;
};

type AccountChoice = { id: number; name: string };

/** Project numbers in typed or pasted text ("4711, 4712 / 4713") - 3 digits at least. */
export const projectNumbersIn = (text: string): ProjectChoice[] =>
  Array.from(new Set((text.match(/\d{3,}/g) ?? []).map(Number))).map((projectId) => ({ project_id: projectId }));

/** What an approval with project numbers granted (helper/location_access.py). */
type GrantedProjects = {
  granted: number[];
  existing: number[];
  missing: number[];
};

/**
 * "Zugangsanfragen" in the staff admin: confirmed requests wait here for a
 * decision. Approving unlocks the account and grants access to the given
 * project numbers (without any it sees no project until one is shared with
 * it), rejecting deactivates it; both mail the requester. Unknown project
 * numbers refuse the approval - most likely a typo, the dialog stays open.
 */
const StaffAccessRequests = ({ onChanged }: { onChanged?: () => void }) => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [loading, setLoading] = useState(true);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState('');
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  // The accounts the user becomes a member of (all their locations).
  const [accounts, setAccounts] = useState<AccountChoice[]>([]);
  const [allAccounts, setAllAccounts] = useState<AccountChoice[] | null>(null);
  const [language, setLanguage] = useState<'de' | 'en'>('de');
  const [decisionError, setDecisionError] = useState('');
  const [busy, setBusy] = useState(false);

  // `loading` is set by whoever asks for other data (filter switch, refresh).
  const fetchRequests = useCallback(() => {
    void axiosConfig.perform_get(
      auth,
      `/api/auth-support/staff/access-requests/?status=${filter}`,
      (result) => {
        setRequests((result?.data?.requests || []) as AccessRequest[]);
        setLoading(false);
      },
      (error) => {
        showRequestError(
          enqueueSnackbar,
          t('staff_requests_load_error'),
          error,
        );
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar, filter, t]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  const changeFilter = (value: 'pending' | 'all') => {
    if (value !== filter) {
      setLoading(true);
      setFilter(value);
    }
  };

  const refresh = () => {
    setLoading(true);
    fetchRequests();
  };

  // The accounts to pick from - once, when the first approval opens.
  const loadAccounts = () => {
    if (allAccounts !== null) {
      return;
    }
    setAllAccounts([]);
    void axiosConfig.perform_get(
      auth,
      '/v1/location/accounts/',
      (result) => setAllAccounts((result?.data?.accounts ?? []) as AccountChoice[]),
      () => setAllAccounts(null),
    );
  };

  const searchProjects = (text: string) =>
    new Promise<ProjectChoice[]>((resolve) => {
      void axiosConfig.perform_get(
        auth,
        `/v1/location/project-search/?q=${encodeURIComponent(text)}`,
        (result) => resolve((result?.data?.projects ?? []) as ProjectChoice[]),
        () => resolve([]),
      );
    });

  const searchAccounts = (text: string) => {
    const needle = text.toLowerCase();
    return (allAccounts ?? []).filter((account) => (account.name || '').toLowerCase().includes(needle));
  };

  const openDecision = (request: AccessRequest, action: Decision['action']) => {
    setNote('');
    setProjects([]);
    setAccounts([]);
    if (action === 'approve') {
      loadAccounts();
    }
    setDecisionError('');
    setLanguage(request.language === 'en' ? 'en' : 'de');
    setDecision({ request, action });
  };

  const showGrantedProjects = (projects: GrantedProjects | null | undefined) => {
    if (!projects) {
      return;
    }
    const parts = [
      ['staff_requests_projects_granted', projects.granted],
      ['staff_requests_projects_existing', projects.existing],
      ['staff_requests_projects_missing', projects.missing],
    ] as const;
    const text = parts
      .filter(([, ids]) => ids?.length)
      .map(([key, ids]) => t(key, { ids: ids.join(', ') }))
      .join(' · ');
    if (text) {
      showInfoBar(enqueueSnackbar, text);
    }
  };

  const submitDecision = () => {
    if (!decision) {
      return;
    }
    setBusy(true);
    setDecisionError('');
    void axiosConfig.perform_post(
      auth,
      `/api/auth-support/staff/access-requests/${decision.request.id}/${decision.action}/`,
      decision.action === 'approve'
        ? {
            note,
            project_ids: projects.map((project) => project.project_id),
            account_ids: accounts.map((account) => account.id),
            language,
          }
        : { note, language },
      (result) => {
        showSuccessBar(
          enqueueSnackbar,
          decision.action === 'approve'
            ? t('staff_requests_approved')
            : t('staff_requests_rejected'),
        );
        showGrantedProjects(result?.data?.projects as GrantedProjects | null);
        const memberOf = (result?.data?.accounts ?? []) as string[];
        if (memberOf.length) {
          showInfoBar(enqueueSnackbar, t('staff_requests_accounts_granted', { accounts: memberOf.join(', ') }));
        }
        setBusy(false);
        setDecision(null);
        fetchRequests();
        onChanged?.();
      },
      (error) => {
        if (error?.response?.data?.unknown_projects || error?.response?.data?.unknown_accounts) {
          // Shown in the dialog, which stays open for the correction.
          setDecisionError(errorReason(error));
        } else {
          showRequestError(
            enqueueSnackbar,
            t('staff_requests_decision_error'),
            error,
          );
        }
        setBusy(false);
      },
    );
  };

  const sorted = useMemo(
    () =>
      [...requests].sort(
        (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
      ),
    [requests],
  );

  const allColumns = useMemo<TableColumn<AccessRequest>[]>(
    () => [
      {
        id: 'status',
        name: t('staff_requests_col_status'),
        width: '120px',
        cell: (row) => (
          <Badge bg={STATUS_VARIANT[row.status]} {...repeatedTestId('staff-requests-status', row.id)}>
            {t(`staff_requests_status_${row.status}`)}
          </Badge>
        ),
      },
      {
        id: 'name',
        name: t('staff_requests_col_name'),
        selector: (row) => `${row.last_name}, ${row.first_name}`,
        sortable: true,
        cell: (row) => (
          <span>
            <strong>
              {row.first_name} {row.last_name}
            </strong>
            <br />
            <small className="text-muted">{row.company}</small>
          </span>
        ),
      },
      {
        id: 'contact',
        name: t('staff_requests_col_contact'),
        cell: (row) => (
          <span className="small">
            <a href={`mailto:${row.email}`} {...repeatedTestId('staff-requests-email', row.id)}>{row.email}</a>
            {row.phone && (
              <>
                <br />
                {row.phone}
              </>
            )}
          </span>
        ),
      },
      {
        id: 'project',
        name: t('staff_requests_col_project'),
        cell: (row) => (
          <span className="small" title={row.message}>
            {row.project || '-'}
            {row.message && (
              <>
                <br />
                <span className="text-muted">
                  {row.message.length > 80
                    ? `${row.message.slice(0, 80)}…`
                    : row.message}
                </span>
              </>
            )}
          </span>
        ),
      },
      {
        id: 'created',
        name: t('staff_requests_col_created'),
        width: '150px',
        selector: (row) => row.created || '',
        sortable: true,
        cell: (row) => (
          <span className="small">
            {row.created || '-'}
            {row.reviewed_at && (
              <>
                <br />
                <span className="text-muted" title={row.review_note}>
                  {row.reviewed_by || ''} {row.reviewed_at}
                </span>
              </>
            )}
          </span>
        ),
      },
      {
        id: 'actions',
        name: t('staff_col_actions'),
        width: '110px',
        cell: (row) =>
          row.status === 'pending' ? (
            <span className="d-flex gap-1">
              <Button
                size="sm"
                variant="outline-success"
                title={t('staff_requests_approve')}
                aria-label={t('staff_requests_approve')}
                onClick={() => openDecision(row, 'approve')}
                {...repeatedTestId('staff-requests-approve', row.id)}
              >
                <CheckLg size={14} />
              </Button>
              <Button
                size="sm"
                variant="outline-danger"
                title={t('staff_requests_reject')}
                aria-label={t('staff_requests_reject')}
                onClick={() => openDecision(row, 'reject')}
                {...repeatedTestId('staff-requests-reject', row.id)}
              >
                <XLg size={14} />
              </Button>
            </span>
          ) : null,
      },
    ],
    // openDecision only runs on a click - it reads the state of that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );
  // Phones: name, actions in the row, the rest in the row's expander.
  const { columns, expandable } = useMobileColumns(allColumns, ['name', 'actions']);

  return (
    <Card className="border-0 shadow-sm my-4 p-3" data-testid="staff-requests">
      <Card.Body>
        <div className="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
          <h5 className="mb-0">
            <PersonCheck className="me-2 text-warning" />
            {t('staff_requests_title')}
          </h5>
          <div className="d-flex gap-2">
            <ButtonGroup size="sm" data-testid="staff-requests-filter">
              <Button
                variant={filter === 'pending' ? 'primary' : 'outline-primary'}
                onClick={() => changeFilter('pending')}
                {...repeatedTestId('staff-requests-filter-option', 'pending')}
              >
                {t('staff_requests_filter_pending')}
              </Button>
              <Button
                variant={filter === 'all' ? 'primary' : 'outline-primary'}
                onClick={() => changeFilter('all')}
                {...repeatedTestId('staff-requests-filter-option', 'all')}
              >
                {t('staff_requests_filter_all')}
              </Button>
            </ButtonGroup>
            <Button variant="outline-secondary" size="sm" onClick={refresh} data-testid="staff-requests-refresh">
              <ArrowRepeat className="me-1" />
              {t('staff_refresh')}
            </Button>
          </div>
        </div>

        <DataTable
          columns={columns}
          data={sorted}
          {...expandable}
          pagination
          paginationPerPage={10}
          progressPending={loading}
          progressComponent={
            <div className="d-flex align-items-center gap-2 text-muted py-4" data-testid="staff-requests-loading">
              <Spinner size="sm" animation="border" />
              {t('staff_loading')}
            </div>
          }
          noDataComponent={
            <div className="text-muted py-4" data-testid="staff-requests-empty">{t('staff_requests_empty')}</div>
          }
          highlightOnHover
          dense
        />
      </Card.Body>

      <Modal show={decision != null} onHide={() => setDecision(null)} centered data-testid="staff-requests-decision">
        <Modal.Header closeButton>
          <Modal.Title>
            {decision?.action === 'approve'
              ? t('staff_requests_approve')
              : t('staff_requests_reject')}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p>
            {t(
              decision?.action === 'approve'
                ? 'staff_requests_approve_text'
                : 'staff_requests_reject_text',
              {
                name: `${decision?.request.first_name || ''} ${decision?.request.last_name || ''}`.trim(),
                email: decision?.request.email || '',
              },
            )}
          </p>
          {decision?.action === 'approve' && (
            <>
              <Form.Group className="mb-3">
                <Form.Label>{t('staff_requests_projects')}</Form.Label>
                <BadgePicker<ProjectChoice>
                  selected={projects}
                  onChange={(next) => {
                    setProjects(next);
                    setDecisionError('');
                  }}
                  keyOf={(project) => project.project_id}
                  badgeLabel={(project) => (
                    <>
                      <strong>{project.project_id}</strong>
                      {project.names?.length ? ` · ${project.names[0]}` : ''}
                    </>
                  )}
                  optionLabel={(project) => (
                    <span className="d-flex justify-content-between gap-3">
                      <span>
                        <strong>{project.project_id}</strong>
                        {project.names?.length ? ` · ${project.names.join(', ')}` : ''}
                        {project.cities?.length ? (
                          <span className="text-muted"> ({project.cities.join(', ')})</span>
                        ) : null}
                      </span>
                      <span className="text-muted small text-nowrap">{project.accounts?.join(', ')}</span>
                    </span>
                  )}
                  search={searchProjects}
                  fromText={projectNumbersIn}
                  placeholder={t('staff_requests_projects_placeholder')}
                  emptyLabel={t('staff_requests_projects_none')}
                  invalid={Boolean(decisionError)}
                  testId="staff-requests-decision-projects"
                />
                {decisionError && (
                  <div className="invalid-feedback d-block" data-testid="staff-requests-decision-error">
                    {decisionError}
                  </div>
                )}
                <Form.Text muted>
                  {decision.request.project
                    ? t('staff_requests_projects_stated', {
                        project: decision.request.project,
                      })
                    : t('staff_requests_projects_hint')}
                </Form.Text>
                {/* Numbers in what the requester wrote - one click each. */}
                {projectNumbersIn(decision.request.project || '')
                  .filter((suggestion) => !projects.some((project) => project.project_id === suggestion.project_id))
                  .map((suggestion) => (
                    <button
                      key={suggestion.project_id}
                      type="button"
                      className="btn btn-sm btn-outline-secondary rounded-pill me-1 mt-1 py-0"
                      onClick={() => setProjects((current) => [...current, suggestion])}
                      {...repeatedTestId('staff-requests-project-suggestion', suggestion.project_id)}
                    >
                      + {suggestion.project_id}
                    </button>
                  ))}
              </Form.Group>
              <Form.Group className="mb-3">
                <Form.Label>{t('staff_requests_accounts')}</Form.Label>
                <BadgePicker<AccountChoice>
                  selected={accounts}
                  onChange={(next) => {
                    setAccounts(next);
                    setDecisionError('');
                  }}
                  keyOf={(account) => account.id}
                  badgeLabel={(account) => account.name}
                  optionLabel={(account) => account.name}
                  search={searchAccounts}
                  delay={0}
                  placeholder={t('staff_requests_accounts_placeholder')}
                  emptyLabel={t('staff_requests_accounts_none')}
                  testId="staff-requests-decision-accounts"
                />
                <Form.Text muted>{t('staff_requests_accounts_hint')}</Form.Text>
              </Form.Group>
            </>
          )}
          <Form.Group className="mb-3">
            <Form.Label>{t('staff_requests_language')}</Form.Label>
            <Form.Select
              value={language}
              onChange={(event) => setLanguage(event.target.value as 'de' | 'en')}
              data-testid="staff-requests-decision-language"
            >
              <option value="de">Deutsch</option>
              <option value="en">English</option>
            </Form.Select>
            <Form.Text muted>
              {decision?.action === 'approve'
                ? t('staff_requests_language_hint_approve')
                : t('staff_requests_language_hint_reject')}
            </Form.Text>
          </Form.Group>
          <Form.Group>
            <Form.Label>{t('staff_requests_note')}</Form.Label>
            <Form.Control
              as="textarea"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              data-testid="staff-requests-decision-note"
            />
            <Form.Text muted>{t('staff_requests_note_hint')}</Form.Text>
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setDecision(null)} data-testid="staff-requests-decision-cancel">
            {t('staff_cancel')}
          </Button>
          <Button
            variant={decision?.action === 'approve' ? 'success' : 'danger'}
            disabled={busy}
            onClick={submitDecision}
            data-testid="staff-requests-decision-submit"
          >
            {decision?.action === 'approve'
              ? t('staff_requests_approve')
              : t('staff_requests_reject')}
          </Button>
        </Modal.Footer>
      </Modal>
    </Card>
  );
};

export default StaffAccessRequests;
