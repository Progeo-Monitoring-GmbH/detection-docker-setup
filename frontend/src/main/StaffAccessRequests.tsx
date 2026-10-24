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
  showRequestError,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';

export type AccessRequestStatus =
  'unverified' | 'pending' | 'approved' | 'rejected';

export type AccessRequest = {
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

/**
 * "Zugangsanfragen" in the staff admin: confirmed requests wait here for a
 * decision. Approving unlocks the account (it still sees no project until
 * one is shared with it), rejecting deactivates it; both mail the requester.
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

  const openDecision = (request: AccessRequest, action: Decision['action']) => {
    setNote('');
    setDecision({ request, action });
  };

  const submitDecision = () => {
    if (!decision) {
      return;
    }
    setBusy(true);
    void axiosConfig.perform_post(
      auth,
      `/api/auth-support/staff/access-requests/${decision.request.id}/${decision.action}/`,
      { note },
      () => {
        showSuccessBar(
          enqueueSnackbar,
          decision.action === 'approve'
            ? t('staff_requests_approved')
            : t('staff_requests_rejected'),
        );
        setBusy(false);
        setDecision(null);
        fetchRequests();
        onChanged?.();
      },
      (error) => {
        showRequestError(
          enqueueSnackbar,
          t('staff_requests_decision_error'),
          error,
        );
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

  const columns = useMemo<TableColumn<AccessRequest>[]>(
    () => [
      {
        name: t('staff_requests_col_status'),
        width: '120px',
        cell: (row) => (
          <Badge bg={STATUS_VARIANT[row.status]}>
            {t(`staff_requests_status_${row.status}`)}
          </Badge>
        ),
      },
      {
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
        name: t('staff_requests_col_contact'),
        cell: (row) => (
          <span className="small">
            <a href={`mailto:${row.email}`}>{row.email}</a>
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
        name: t('staff_col_actions'),
        width: '110px',
        cell: (row) =>
          row.status === 'pending' ? (
            <span className="d-flex gap-1">
              <Button
                size="sm"
                variant="outline-success"
                title={t('staff_requests_approve')}
                onClick={() => openDecision(row, 'approve')}
              >
                <CheckLg size={14} />
              </Button>
              <Button
                size="sm"
                variant="outline-danger"
                title={t('staff_requests_reject')}
                onClick={() => openDecision(row, 'reject')}
              >
                <XLg size={14} />
              </Button>
            </span>
          ) : null,
      },
    ],
    [t],
  );

  return (
    <Card className="border-0 shadow-sm my-4 p-3">
      <Card.Body>
        <div className="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
          <h5 className="mb-0">
            <PersonCheck className="me-2 text-warning" />
            {t('staff_requests_title')}
          </h5>
          <div className="d-flex gap-2">
            <ButtonGroup size="sm">
              <Button
                variant={filter === 'pending' ? 'primary' : 'outline-primary'}
                onClick={() => changeFilter('pending')}
              >
                {t('staff_requests_filter_pending')}
              </Button>
              <Button
                variant={filter === 'all' ? 'primary' : 'outline-primary'}
                onClick={() => changeFilter('all')}
              >
                {t('staff_requests_filter_all')}
              </Button>
            </ButtonGroup>
            <Button variant="outline-secondary" size="sm" onClick={refresh}>
              <ArrowRepeat className="me-1" />
              {t('staff_refresh')}
            </Button>
          </div>
        </div>

        <DataTable
          columns={columns}
          data={sorted}
          pagination
          paginationPerPage={10}
          progressPending={loading}
          progressComponent={
            <div className="d-flex align-items-center gap-2 text-muted py-4">
              <Spinner size="sm" animation="border" />
              {t('staff_loading')}
            </div>
          }
          noDataComponent={
            <div className="text-muted py-4">{t('staff_requests_empty')}</div>
          }
          highlightOnHover
          dense
        />
      </Card.Body>

      <Modal show={decision != null} onHide={() => setDecision(null)} centered>
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
          <Form.Group>
            <Form.Label>{t('staff_requests_note')}</Form.Label>
            <Form.Control
              as="textarea"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <Form.Text muted>{t('staff_requests_note_hint')}</Form.Text>
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setDecision(null)}>
            {t('staff_cancel')}
          </Button>
          <Button
            variant={decision?.action === 'approve' ? 'success' : 'danger'}
            disabled={busy}
            onClick={submitDecision}
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
