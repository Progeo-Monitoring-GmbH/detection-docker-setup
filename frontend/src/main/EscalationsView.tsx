import { useCallback, useEffect, useState } from 'react';
import { Button, Form, Spinner } from 'react-bootstrap';
import { ArrowRepeat, CheckCircle, ChatLeftText, Search, XLg } from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from 'notistack';
import { Link, useNavigate, useParams } from 'react-router';
import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import BoldTrans from '../components/ui/kit/BoldTrans';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import PanelCard from '../components/ui/kit/PanelCard';
import SegmentedControl from '../components/ui/kit/SegmentedControl';
import { showRequestError } from '../components/ui/Snackbar.jsx';
import { matchesSearchWords, searchWords } from '../components/ui/kit/tableSearch';
import { foldSearchText } from '../components/location/locationSearch';
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
import { staffFlags } from './access';
import { repeatedTestId } from '../testIds';
import './EscalationsView.css';
import StatusViewSummary from './StatusViewSummary';
import { statusViewPath } from './statusViewState';

type StateFilter = 'open' | 'closed' | 'all';

/** The text the list's filter field searches: title, project, object, people, status. */
const escalationSearchText = (escalation: Escalation, statusLabel: string) =>
  foldSearchText(
    [
      escalation.title,
      escalation.project_id,
      escalation.location_name,
      escalation.assigned_to_name,
      escalation.created_by_name,
      statusLabel,
    ]
      .filter((part) => part != null && part !== '')
      .join('\n'),
  );

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
  const isStaff = staffFlags(auth?.user).isStaffOrSuperuser;

  const [filter, setFilter] = useState<StateFilter>('open');
  const [query, setQuery] = useState('');
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
      (response) =>
        setList((response?.data?.escalations ?? []) as Escalation[]),
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
      (response) =>
        setDetail((response?.data?.escalation ?? null) as Escalation | null),
      (error) =>
        showRequestError(enqueueSnackbar, t('escalation_load_failed'), error),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, isStaff]);

  if (!isStaff) {
    return (
      <div
        className="text-muted py-5 text-center"
        data-testid="page-escalations"
      >
        {t('escalation_staff_only')}
      </div>
    );
  }

  // The loaded escalation, while it is the selected one.
  const shown = detail?.id === selectedId ? detail : null;

  /** A changed escalation: in the detail and in the list. */
  const changed = (escalation: Escalation) => {
    setDetail(escalation);
    loadList();
  };

  return (
    <div
      className="d-flex flex-column flex-xl-row gap-3 align-items-stretch"
      data-testid="page-escalations"
    >
      <div className="escalations-list-col">
        <PanelCard
          testId="escalations-list"
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
                testId="escalations-filter"
              />
              <Button
                size="sm"
                variant="link"
                onClick={loadList}
                title={t('escalation_refresh')}
                aria-label={t('escalation_refresh')}
                data-testid="escalations-refresh"
              >
                <ArrowRepeat />
              </Button>
            </div>
          }
        >
          <div className="progeo-table-search escalations-search">
            <Search aria-hidden size={13} className="progeo-table-search-icon" />
            <input
              type="search"
              value={query}
              placeholder={t('escalation_search')}
              aria-label={t('escalation_search')}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setQuery('');
                }
              }}
              className="progeo-table-search-input"
              data-testid="escalations-search"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('escalation_search_clear')}
                title={t('escalation_search_clear')}
                className="progeo-table-search-clear"
              >
                <XLg size={10} />
              </button>
            )}
          </div>
          <EscalationList
            list={
              list && searchWords(query).length
                ? list.filter((escalation) =>
                    matchesSearchWords(
                      escalationSearchText(escalation, t(statusKey(escalation.status))),
                      searchWords(query),
                    ),
                  )
                : list
            }
            filtered={searchWords(query).length > 0}
            selectedId={selectedId}
            onSelect={(escalation) => navigate(escalationPath(escalation.id))}
          />
        </PanelCard>
      </div>
      {selectedId != null && (
        <div className="escalations-detail-col">
          {shown ? (
            // Remounted with every change: the controls start from the saved values.
            <EscalationDetail
              key={`${shown.id}-${shown.updated}`}
              escalation={shown}
              staff={staff}
              onChanged={changed}
            />
          ) : (
            <PanelCard testId="escalation-detail-loading">
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
  filtered,
  selectedId,
  onSelect,
}: {
  list: Escalation[] | null;
  /** A search narrows the list: "no match" instead of "no escalations". */
  filtered: boolean;
  selectedId: number | null;
  onSelect: (escalation: Escalation) => void;
}) => {
  const { t } = useTranslation();
  if (list == null) {
    return (
      <div
        className="d-flex justify-content-center py-4 text-muted"
        data-testid="escalations-list-loading"
      >
        <Spinner size="sm" animation="border" />
      </div>
    );
  }
  if (list.length === 0) {
    return (
      <div
        className="text-muted small py-3"
        data-testid="escalations-list-empty"
      >
        {filtered ? t('escalation_search_none') : t('escalation_none')}
      </div>
    );
  }
  return (
    <div className="d-flex flex-column gap-2" data-testid="escalations-items">
      {list.map((escalation) => (
        <button
          key={escalation.id}
          type="button"
          onClick={() => onSelect(escalation)}
          className={`text-start border-0 w-100 escalations-item${escalation.id === selectedId ? ' escalations-item--selected' : ''}`}
          {...repeatedTestId('escalations-item', escalation.id)}
        >
          <div className="d-flex align-items-center gap-2">
            <span className="escalations-item-title">{escalation.title}</span>
            <span className="ms-auto">
              <EscalationStatusBadge
                status={escalation.status}
                testId="escalations-item-status"
                testKey={escalation.id}
              />
            </span>
          </div>
          <div className="small text-muted d-flex flex-wrap gap-2 mt-1">
            <span>
              {escalation.project_id ?? '–'} · {escalation.location_name ?? '–'}
            </span>
            <span>· {formatDate(escalation.created, 'dateTime')}</span>
            <span>
              · {escalation.assigned_to_name ?? t('escalation_unassigned')}
            </span>
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
  const [assignee, setAssignee] = useState<string>(
    escalation.assigned_to?.toString() ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [askClose, setAskClose] = useState(false);
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
    setAskClose(false);
    act('close');
  };

  return (
    <PanelCard
      testId="escalation-detail"
      title={
        <span className="d-flex align-items-center gap-2 flex-wrap">
          {escalation.title}
          <EscalationStatusBadge
            status={escalation.status}
            testId="escalation-detail-status"
          />
        </span>
      }
    >
      <div className="small text-muted mb-3 d-flex flex-wrap gap-2">
        <Link
          to={`/location/${escalation.location}/status`}
          data-testid="escalation-detail-location"
        >
          {t('escalation_project')} {escalation.project_id ?? '–'} ·{' '}
          {escalation.location_name ?? '–'}
        </Link>
        <span>
          ·{' '}
          {t('escalation_opened_by', {
            name: escalation.created_by_name ?? '–',
          })}{' '}
          {formatDate(escalation.created, 'dateTime')}
        </span>
        {escalation.closed_at && (
          <span>
            ·{' '}
            {t('escalation_closed_by', {
              name: escalation.closed_by_name ?? '–',
            })}{' '}
            {formatDate(escalation.closed_at, 'dateTime')}
          </span>
        )}
      </div>

      {escalation.view_state && (
        <div
          className="escalation-view-box mb-3"
          data-testid="escalation-detail-view"
        >
          <div className="d-flex flex-wrap align-items-center gap-2">
            <span className="escalation-view-title">
              {t('escalation_view_title')}
            </span>
            <Link
              className="ms-auto btn btn-sm btn-primary"
              to={statusViewPath(escalation.location, escalation.view_state)}
              data-testid="escalation-detail-view-open"
            >
              {t('escalation_view_open')}
            </Link>
          </div>
          <StatusViewSummary
            state={escalation.view_state}
            testId="escalation-detail-view-summary"
          />
        </div>
      )}

      <EscalationProtocol entries={escalation.entries ?? []} />

      {isOpen ? (
        // Three groups, each control next to its own button: the message and
        // "Comment", the changes (status, assignee) as labelled rows, closing
        // apart at the bottom. The message goes with whichever action is used.
        <div className="escalation-actions" data-testid="escalation-detail-actions">
          <div className="escalation-actions-compose">
            <Form.Control
              as="textarea"
              rows={3}
              value={message}
              maxLength={5000}
              placeholder={t('escalation_message_placeholder')}
              aria-label={t('escalation_message_placeholder')}
              onChange={(event) => setMessage(event.target.value)}
              data-testid="escalation-message"
            />
            <div className="escalation-actions-compose-foot">
              <span className="small text-muted">{t('escalation_message_hint')}</span>
              <Button
                size="sm"
                onClick={() => act('comment')}
                disabled={busy || !message.trim()}
                data-testid="escalation-comment"
              >
                <ChatLeftText className="me-1" />
                {t('escalation_comment')}
              </Button>
            </div>
          </div>

          <div className="escalation-actions-grid">
            <label className="escalation-actions-label" htmlFor="escalation-status-select">
              {t('escalation_status')}
            </label>
            <Form.Select
              id="escalation-status-select"
              size="sm"
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as EscalationStatus)
              }
              data-testid="escalation-status-select"
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
              data-testid="escalation-set-status"
            >
              {t('escalation_set_status')}
            </Button>

            <label className="escalation-actions-label" htmlFor="escalation-assignee-select">
              {t('escalation_assignee')}
            </label>
            <Form.Select
              id="escalation-assignee-select"
              size="sm"
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
              data-testid="escalation-assignee-select"
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
              onClick={() =>
                act('assign', {
                  assigned_to: assignee ? Number(assignee) : null,
                })
              }
              disabled={
                busy || assignee === (escalation.assigned_to?.toString() ?? '')
              }
              data-testid="escalation-assign"
            >
              {t('escalation_assign')}
            </Button>
          </div>

          <div className="escalation-actions-close">
            <Button
              size="sm"
              variant="outline-danger"
              onClick={() => setAskClose(true)}
              disabled={busy}
              data-testid="escalation-close"
            >
              <CheckCircle className="me-1" />
              {t('escalation_close')}
            </Button>
          </div>
        </div>
      ) : (
        <div
          className="small text-muted mt-3"
          data-testid="escalation-closed-hint"
        >
          {t('escalation_closed_hint')}
        </div>
      )}

      <ConfirmDialog
        show={askClose}
        title={t('escalation_close_confirm_title')}
        message={
          <BoldTrans
            i18nKey="escalation_close_confirm"
            values={{
              title: escalation.title,
              location: `${escalation.project_id ?? '-'} ${escalation.location_name ?? ''}`.trim(),
            }}
          />
        }
        confirmLabel={t('escalation_close')}
        cancelLabel={t('staff_cancel')}
        onConfirm={close}
        onCancel={() => setAskClose(false)}
        testId="escalation-close-dialog"
      />
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
          <div
            key={entry.id}
            {...repeatedTestId('escalation-protocol-entry', entry.id)}
          >
            <div className="small text-muted d-flex flex-wrap gap-1">
              <strong className="escalations-entry-author">
                {entry.author_name ?? '–'}
              </strong>
              <span>{formatDate(entry.created, 'dateTime')}</span>
              {line && <span>· {line}</span>}
            </div>
            {entry.text && (
              <div
                className={
                  entry.kind === 'comment'
                    ? 'escalations-entry-text escalations-entry-text--comment'
                    : 'escalations-entry-text'
                }
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
