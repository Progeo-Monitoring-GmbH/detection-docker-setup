import { useEffect, useState } from 'react';
import { Button, Col, Form, Modal, Row, Spinner } from 'react-bootstrap';
import { ExclamationTriangleFill } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import {
  showRequestError,
  showSuccessBar,
} from '../components/ui/Snackbar.jsx';
import EscalationStatusBadge from './EscalationStatusBadge';
import {
  ESCALATION_URL,
  escalationPath,
  type Escalation,
  type StaffUser,
} from './escalations';
import { staffFlags } from './access';
import StatusViewSummary from './StatusViewSummary';
import { currentStatusView, statusViewPath } from './statusViewState';
import './Escalation.css';

/**
 * Staff and superusers only, at the top of the project portal: whether the
 * project is in escalation (its open escalation, linked to the Escalations
 * page) - otherwise "Create Escalation". Nobody else sees that a project is
 * escalated here.
 */
const EscalationBanner = ({ locationId }: { locationId: number }) => {
  const { t } = useTranslation();
  const auth = useAuth();
  const isStaff = staffFlags(auth?.user).isStaffOrSuperuser;
  // The location's open escalation (null: none) - undefined until it is known.
  const [loaded, setLoaded] = useState<{
    locationId: number;
    escalation: Escalation | null;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const open =
    loaded?.locationId === locationId ? loaded.escalation : undefined;
  const setOpen = (escalation: Escalation | null) =>
    setLoaded({ locationId, escalation });

  useEffect(() => {
    if (!isStaff || !locationId) {
      return;
    }
    void axiosConfig.perform_get(
      auth,
      `${ESCALATION_URL}?state=open&location=${locationId}`,
      (response) =>
        setLoaded({
          locationId,
          escalation:
            ((response?.data?.escalations ?? []) as Escalation[])[0] ?? null,
        }),
      () => setLoaded({ locationId, escalation: null }),
    );
    // Once per location - `auth` changes with the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStaff, locationId]);

  if (!isStaff || open === undefined) {
    return null;
  }

  if (open) {
    return (
      <div
        className="d-flex flex-wrap align-items-center gap-2 escalation-banner"
        data-testid="escalation-banner"
      >
        <ExclamationTriangleFill />
        <strong>{t('escalation_banner_title')}</strong>
        <span>{open.title}</span>
        <EscalationStatusBadge
          status={open.status}
          testId="escalation-banner-status"
        />
        <span className="small">
          · {open.assigned_to_name ?? t('escalation_unassigned')}
        </span>
        {open.view_state && (
          <Link
            className="ms-auto small fw-semibold escalation-banner-link"
            to={statusViewPath({ id: open.location, project_id: open.project_id }, open.view_state)}
            data-testid="escalation-banner-view"
          >
            {t('escalation_view_open')}
          </Link>
        )}
        <Link
          className={`${open.view_state ? '' : 'ms-auto '}small fw-semibold escalation-banner-link`}
          to={escalationPath(open.id)}
          data-testid="escalation-banner-open"
        >
          {t('escalation_banner_open')}
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="d-flex justify-content-end">
        <Button
          size="sm"
          variant="outline-danger"
          onClick={() => setCreating(true)}
          data-testid="escalation-create"
        >
          <ExclamationTriangleFill className="me-1" />
          {t('escalation_create')}
        </Button>
      </div>
      {creating && (
        <CreateEscalationModal
          locationId={locationId}
          onClose={() => setCreating(false)}
          onCreated={(escalation) => {
            setCreating(false);
            setOpen(escalation);
          }}
        />
      )}
    </>
  );
};

const CreateEscalationModal = ({
  locationId,
  onClose,
  onCreated,
}: {
  locationId: number;
  onClose: () => void;
  onCreated: (escalation: Escalation) => void;
}) => {
  const { t } = useTranslation();
  const auth = useAuth();
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [assignee, setAssignee] = useState('');
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [busy, setBusy] = useState(false);
  // What the status page shows as the dialog opens - kept with the
  // escalation unless unticked (statusViewState.ts).
  const [viewState] = useState(() => currentStatusView(locationId));
  const [withView, setWithView] = useState(true);

  useEffect(() => {
    void axiosConfig.perform_get(
      auth,
      `${ESCALATION_URL}staff/`,
      (response) => setStaff((response?.data?.users ?? []) as StaffUser[]),
      () => setStaff([]),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = () => {
    setBusy(true);
    void axiosConfig.perform_post(
      auth,
      ESCALATION_URL,
      {
        location: locationId,
        title,
        text,
        assigned_to: assignee ? Number(assignee) : null,
        view_state: withView ? viewState : null,
      },
      (response) => {
        const escalation = response.data.escalation as Escalation;
        showSuccessBar(enqueueSnackbar, t('escalation_created'));
        onCreated(escalation);
        navigate(escalationPath(escalation.id));
      },
      (error) => {
        setBusy(false);
        showRequestError(enqueueSnackbar, t('escalation_action_failed'), error);
      },
    );
  };

  return (
    <Modal
      show
      onHide={onClose}
      centered
      size="lg"
      data-testid="escalation-create-dialog"
    >
      <Modal.Header closeButton>
        <Modal.Title>{t('escalation_create')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Row className="g-4">
          <Col lg={7} className="d-flex flex-column gap-3">
            <Form.Group>
              <Form.Label>{t('escalation_title_label')}</Form.Label>
              <Form.Control
                value={title}
                maxLength={200}
                autoFocus
                onChange={(event) => setTitle(event.target.value)}
                data-testid="escalation-create-title"
              />
            </Form.Group>
            <Form.Group>
              <Form.Label>{t('escalation_reason_label')}</Form.Label>
              <Form.Control
                as="textarea"
                rows={4}
                value={text}
                maxLength={5000}
                onChange={(event) => setText(event.target.value)}
                data-testid="escalation-create-reason"
              />
            </Form.Group>
            <Form.Group>
              <Form.Label>{t('escalation_assignee')}</Form.Label>
              <Form.Select
                value={assignee}
                onChange={(event) => setAssignee(event.target.value)}
                data-testid="escalation-create-assignee"
              >
                <option value="">{t('escalation_unassigned')}</option>
                {staff.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          </Col>
          <Col lg={5}>
            {/* The view the escalation's link will open. */}
            <div
              className="escalation-view-box"
              data-testid="escalation-create-view"
            >
              <div className="escalation-view-title">
                {t('escalation_view_title')}
              </div>
              {viewState ? (
                <>
                  <Form.Check
                    type="switch"
                    id="escalation-create-with-view"
                    label={t('escalation_view_include')}
                    checked={withView}
                    onChange={(event) => setWithView(event.target.checked)}
                    data-testid="escalation-create-with-view"
                  />
                  <div className={withView ? undefined : 'escalation-view-off'}>
                    <StatusViewSummary
                      state={viewState}
                      testId="escalation-create-view-summary"
                    />
                  </div>
                  <div className="small text-muted">
                    {t('escalation_view_hint')}
                  </div>
                </>
              ) : (
                <div
                  className="small text-muted"
                  data-testid="escalation-create-view-none"
                >
                  {t('escalation_view_none')}
                </div>
              )}
            </div>
          </Col>
        </Row>
      </Modal.Body>
      <Modal.Footer>
        <Button
          variant="outline-secondary"
          onClick={onClose}
          disabled={busy}
          data-testid="escalation-create-cancel"
        >
          {t('heat_limit_cancel')}
        </Button>
        <Button
          variant="danger"
          onClick={submit}
          disabled={busy || !title.trim()}
          data-testid="escalation-create-submit"
        >
          {busy && <Spinner size="sm" animation="border" className="me-1" />}
          {t('escalation_create')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
};

export default EscalationBanner;
