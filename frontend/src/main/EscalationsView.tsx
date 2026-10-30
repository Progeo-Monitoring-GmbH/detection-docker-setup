import { useCallback, useEffect, useState } from 'react';
import { Button, Form, Spinner } from 'react-bootstrap';
import { ArrowRepeat, CheckCircle, ChatLeftText } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { Link, useNavigate, useParams } from 'react-router';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import PanelCard from '../components/ui/kit/PanelCard';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import { formatDate } from './dateFormat';
import EscalationStatusBadge from './EscalationStatusBadge';
import {
  ESCALATION_URL,
  SETTABLE_STATUSES,
  escalationPath,
  statusKey,
  type Escalation,
  type EscalationEntry,
  type EscalationStatus,
  type StaffUser,
} from './escalations';

type StateFilter = 'open' | 'closed' | 'all';

/**
 * Escalations (sidebar: Alle Objekte > Escalations) - for staff: every
 * escalation of every project, filtered by state; the selected one
 * (/escalations/:id) with its protocol, a chat of comments and changes.
 * Staff comment, change the status, assign it to a staff user and close
 * it - each with an optional message that goes into the protocol.
 * Superusers open escalations in the project portal (EscalationBanner).
 */
const EscalationsView = () => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const navigate = useNavigate();
  const { id } = useParams();
  const selectedId = id ? Number(id) : null;
  const user = auth?.user as { is_staff?: boolean; is_superuser?: boolean } | null;
  const isStaff = Boolean(user?.is_staff || user?.is_superuser);

  const [filter, setFilter] = useState<StateFilter>('open');
  const [list, setList] = useState<Escalation[] | null>(null);
  const [detail, setDetail] = useState<Escalation | null>(null);
  const [staff, setStaff] = useState<StaffUser[]>([]);

  const loadList = useCallback(() => {
    if (!isStaff) {
      return;
    }
    void axiosConfig.perform_get(
      auth,
      `${ESCALATION_URL}?state=${filter}`,
      (response) => setList((response?.data?.escalations ?? []) as Escalation[]),
      (error) => {
        setList([]);
        showRequestError(enqueueSnackbar, t('escalation_load_failed'), error);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, isStaff]);

  useEffect(loadList, [loadList]);

  useEffect(() => {
    if (!isStaff) {
      return;
    }
    void axiosConfig.perform_get(
      auth,
      `${ESCALATION_URL}staff/`,
      (response) => setStaff((response?.data?.users ?? []) as StaffUser[]),
      () => setStaff([]),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStaff]);

  useEffect(() => {
    if (!isStaff || selectedId == null) {
      return;
    }
    void axiosConfig.perform_get(
      auth,
      `${ESCALATION_URL}${selectedId}/`,
      (response) => setDetail((response?.data?.escalation ?? null) as Escalation | null),
      (error) => showRequestError(enqueueSnackbar, t('escalation_load_failed'), error),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, isStaff]);

  if (!isStaff) {
    return <div className="text-muted py-5 text-center">{t('escalation_staff_only')}</div>;
  }

  // The loaded escalation, while it is the selected one.
  const shown = detail?.id === selectedId ? detail : null;

  /** A changed escalation: in the detail and in the list. */
  const changed = (escalation: Escalation) => {
    setDetail(escalation);
    loadList();
  };

  return (
    <div className="d-flex flex-column flex-xl-row gap-3 align-items-stretch">
      <div style={{ flex: '1 1 0', minWidth: 0 }}>
        <PanelCard
          title={t('escalations_title')}
          actions={
            <div className="d-flex align-items-center gap-2">
              <SegmentedControl
                options={[
                  { value: 'open', label: t('escalation_filter_open') },
                  { value: 'closed', label: t('escalation_filter_closed') },
                  { value: 'all', label: t('escalation_filter_all') },
                ]}
                value={filter}
                onChange={(value) => setFilter(value as StateFilter)}
              />
              <Button size="sm" variant="link" onClick={loadList} title={t('escalation_refresh')}>
                <ArrowRepeat />
              </Button>
            </div>
          }
        >
          <EscalationList
            list={list}
            selectedId={selectedId}
            onSelect={(escalation) => navigate(escalationPath(escalation.id))}
          />
        </PanelCard>
      </div>
      {selectedId != null && (
        <div style={{ flex: '1.2 1 0', minWidth: 0 }}>
          {shown ? (
            // Remounted with every change: the controls start from the saved values.
            <EscalationDetail
              key={`${shown.id}-${shown.updated}`}
              escalation={shown}
              staff={staff}
              onChanged={changed}
            />
          ) : (
            <PanelCard>
              <div className="d-flex justify-content-center py-4 text-muted">
                <Spinner size="sm" animation="border" />
              </div>
            </PanelCard>
          )}
        </div>
      )}
    </div>
  );
};

const EscalationList = ({
  list,
  selectedId,
  onSelect,
}: {
  list: Escalation[] | null;
  selectedId: number | null;
  onSelect: (escalation: Escalation) => void;
}) => {
  const { t } = useTranslation();
  if (list == null) {
    return (
      <div className="d-flex justify-content-center py-4 text-muted">
        <Spinner size="sm" animation="border" />
      </div>
    );
  }
  if (list.length === 0) {
    return <div className="text-muted small py-3">{t('escalation_none')}</div>;
  }
  return (
    <div className="d-flex flex-column gap-2">
      {list.map((escalation) => (
        <button
          key={escalation.id}
          type="button"
          onClick={() => onSelect(escalation)}
          className="text-start border-0 w-100"
          style={{
            background: escalation.id === selectedId ? 'var(--progeo-surface)' : 'transparent',
            borderRadius: 10,
            padding: '10px 12px',
            boxShadow: escalation.id === selectedId ? 'inset 0 0 0 1px #D0CACA' : 'none',
            color: 'var(--progeo-blue)',
          }}
        >
          <div className="d-flex align-items-center gap-2">
            <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {escalation.title}
            </span>
            <span className="ms-auto">
              <EscalationStatusBadge status={escalation.status} />
            </span>
          </div>
          <div className="small text-muted d-flex flex-wrap gap-2 mt-1">
            <span>
              {escalation.project_id ?? '–'} · {escalation.location_name ?? '–'}
            </span>
            <span>· {formatDate(escalation.created, 'dateTime')}</span>
            <span>· {escalation.assigned_to_name ?? t('escalation_unassigned')}</span>
            <span className="d-inline-flex align-items-center gap-1">
              · <ChatLeftText size={11} /> {escalation.entry_count}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
};

const EscalationDetail = ({
  escalation,
  staff,
  onChanged,
}: {
  escalation: Escalation;
  staff: StaffUser[];
  onChanged: (escalation: Escalation) => void;
}) => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<EscalationStatus>(escalation.status);
  const [assignee, setAssignee] = useState<string>(escalation.assigned_to?.toString() ?? '');
  const [busy, setBusy] = useState(false);
  const isOpen = escalation.status !== 'closed';

  /** An action with the message as its protocol text. */
  const act = (action: string, data: Record<string, unknown> = {}) => {
    setBusy(true);
    void axiosConfig.perform_post(
      auth,
      `${ESCALATION_URL}${escalation.id}/${action}/`,
      { text: message, ...data },
      (response) => {
        setBusy(false);
        setMessage('');
        onChanged(response.data.escalation as Escalation);
      },
      (error) => {
        setBusy(false);
        showRequestError(enqueueSnackbar, t('escalation_action_failed'), error);
      },
    );
  };

  const close = () => {
    if (window.confirm(t('escalation_close_confirm'))) {
      act('close');
    }
  };

  return (
    <PanelCard
      title={
        <span className="d-flex align-items-center gap-2 flex-wrap">
          {escalation.title}
          <EscalationStatusBadge status={escalation.status} />
        </span>
      }
    >
      <div className="small text-muted mb-3 d-flex flex-wrap gap-2">
        <Link to={`/location/${escalation.location}/status`}>
          {t('escalation_project')} {escalation.project_id ?? '–'} · {escalation.location_name ?? '–'}
        </Link>
        <span>
          · {t('escalation_opened_by', { name: escalation.created_by_name ?? '–' })}{' '}
          {formatDate(escalation.created, 'dateTime')}
        </span>
        {escalation.closed_at && (
          <span>
            · {t('escalation_closed_by', { name: escalation.closed_by_name ?? '–' })}{' '}
            {formatDate(escalation.closed_at, 'dateTime')}
          </span>
        )}
      </div>

      <EscalationProtocol entries={escalation.entries ?? []} />

      {isOpen ? (
        <div className="mt-3 d-flex flex-column gap-2">
          <Form.Control
            as="textarea"
            rows={3}
            value={message}
            maxLength={5000}
            placeholder={t('escalation_message_placeholder')}
            aria-label={t('escalation_message_placeholder')}
            onChange={(event) => setMessage(event.target.value)}
          />
          <div className="d-flex flex-wrap align-items-center gap-2">
            <Button size="sm" onClick={() => act('comment')} disabled={busy || !message.trim()}>
              <ChatLeftText className="me-1" />
              {t('escalation_comment')}
            </Button>
            <span className="vr mx-1" />
            <Form.Select
              size="sm"
              style={{ width: 'auto' }}
              aria-label={t('escalation_status')}
              value={status}
              onChange={(event) => setStatus(event.target.value as EscalationStatus)}
            >
              {SETTABLE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(statusKey(value))}
                </option>
              ))}
            </Form.Select>
            <Button
              size="sm"
              variant="outline-primary"
              onClick={() => act('status', { status })}
              disabled={busy || status === escalation.status}
            >
              {t('escalation_set_status')}
            </Button>
            <span className="vr mx-1" />
            <Form.Select
              size="sm"
              style={{ width: 'auto' }}
              aria-label={t('escalation_assignee')}
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
            >
              <option value="">{t('escalation_unassigned')}</option>
              {staff.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </Form.Select>
            <Button
              size="sm"
              variant="outline-primary"
              onClick={() => act('assign', { assigned_to: assignee ? Number(assignee) : null })}
              disabled={busy || assignee === (escalation.assigned_to?.toString() ?? '')}
            >
              {t('escalation_assign')}
            </Button>
            <Button size="sm" variant="outline-danger" className="ms-auto" onClick={close} disabled={busy}>
              <CheckCircle className="me-1" />
              {t('escalation_close')}
            </Button>
          </div>
          <div className="small text-muted">{t('escalation_message_hint')}</div>
        </div>
      ) : (
        <div className="small text-muted mt-3">{t('escalation_closed_hint')}</div>
      )}
    </PanelCard>
  );
};

/** The protocol as a chat: comments as bubbles, changes as lines between them. */
const EscalationProtocol = ({ entries }: { entries: EscalationEntry[] }) => {
  const { t } = useTranslation();

  const change = (entry: EscalationEntry) => {
    const { data } = entry;
    switch (entry.kind) {
      case 'created':
        return t('escalation_entry_created');
      case 'status':
        return t('escalation_entry_status', {
          from: t(statusKey(data.from as EscalationStatus)),
          to: t(statusKey(data.to as EscalationStatus)),
        });
      case 'assigned':
        return data.to_name
          ? t('escalation_entry_assigned', { name: data.to_name as string })
          : t('escalation_entry_unassigned');
      case 'closed':
        return t('escalation_entry_closed');
      default:
        return null;
    }
  };

  return (
    <div className="d-flex flex-column gap-2" data-testid="escalation-protocol">
      {entries.map((entry) => {
        const line = change(entry);
        return (
          <div key={entry.id}>
            <div className="small text-muted d-flex flex-wrap gap-1">
              <strong style={{ color: 'var(--progeo-blue)' }}>{entry.author_name ?? '–'}</strong>
              <span>{formatDate(entry.created, 'dateTime')}</span>
              {line && <span>· {line}</span>}
            </div>
            {entry.text && (
              <div
                style={{
                  whiteSpace: 'pre-wrap',
                  background: entry.kind === 'comment' ? 'var(--progeo-surface)' : '#F7F3E8',
                  borderRadius: 10,
                  padding: '8px 12px',
                  marginTop: 2,
                }}
              >
                {entry.text}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default EscalationsView;
