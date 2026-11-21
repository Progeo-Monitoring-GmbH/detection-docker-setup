import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, ButtonGroup, Card, Form, Modal, Spinner, Table } from 'react-bootstrap';
import { ArrowRepeat, BellFill, BellSlashFill, Trash3Fill } from 'react-bootstrap-icons';
import DataTable from 'react-data-table-component';
import type { TableColumn } from 'react-data-table-component';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';

import { useAuth } from '../../hooks/CoreAuthProvider';
import axiosConfig from '../axiosConfig';
import { showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import { useMobileColumns } from '../components/ui/kit/mobileTable';
import ScrollShadow from '../components/ui/kit/ScrollShadow';
import useIsMobile from '../components/ui/useIsMobile';
import { repeatedTestId } from '../testIds';
import {
  LocationFlagIcons,
  LOCATION_OFF_CLASS,
  isLocationOff,
  locationOffRowStyle,
  useLocationFlags,
  type LocationFlags,
} from '../components/location/locationFlags';
import './StaffNotificationCases.css';

type Kind = 'offline' | 'alarm';
type Phase = 'detected' | 'notified' | 'reminder' | 'escalated' | 'recovering' | 'muted' | 'resolved';

type CaseEvent = {
  id: number;
  kind: string;
  created: string | null;
  text: string;
  data: Record<string, unknown>;
};

type NotificationCase = {
  id: number;
  kind: Kind;
  state: 'open' | 'resolved';
  phase: Phase;
  stage: number;
  stages: number;
  location_id: number;
  project_id: number | null;
  location_name: string;
  opened_at: string | null;
  last_contact_at: string | null;
  next_contact_at: string | null;
  muted: boolean;
  muted_until: string | null;
  unreachable_since: string | null;
  acknowledged_at: string | null;
  escalation_id: number | null;
  resolved_at: string | null;
  resolution: string;
  back_since: string | null;
  devices: { id: string; label: string; last_seen: string | null; back_since: string | null }[];
  alarm_count: number;
  notified: string[];
  /** The location's switch (ProgeoLocation.notifications_disabled); null = location unknown. */
  notifications_disabled: boolean | null;
  events?: CaseEvent[];
};

type Summary = {
  counts: Record<Kind, Record<string, number>>;
  /** Locations by their notification switch (ProgeoLocation.notifications_disabled). */
  locations?: { disabled: number; enabled: number };
  /** Messages logged but not sent in the last 24 h (disabled locations). */
  withheld_last_day?: number;
  resolved_last_day: Partial<Record<Kind, number>>;
  in_window: boolean;
  baseline_done: boolean;
  unsubscribed_last_week: number;
  no_recipients_left: number;
};

const PHASE_VARIANT: Record<Phase, string> = {
  detected: 'secondary',
  notified: 'primary',
  reminder: 'warning',
  escalated: 'danger',
  recovering: 'info',
  muted: 'dark',
  resolved: 'success',
};

const SUMMARY_PHASES = ['open', 'detected', 'notified', 'reminder', 'escalated', 'recovering', 'muted', 'unreachable'];

/**
 * "Benachrichtigungen" in the staff admin: in which phase every location's
 * notification case is (offline / alarm, helper/notification_cases.py) -
 * detected, notified, reminders, escalated, recovering, muted - with its
 * protocol, and the staff actions mute / release / close. On top: how many
 * locations are switched on - only those get their messages sent.
 */
const StaffNotificationCases = () => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [cases, setCases] = useState<NotificationCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<'open' | 'resolved' | 'all'>('open');
  const [kind, setKind] = useState<'' | Kind>('');
  const [selected, setSelected] = useState<NotificationCase | null>(null);
  const [busy, setBusy] = useState(false);
  // "Close case" asks first (a ConfirmDialog inside the case's modal).
  const [askClose, setAskClose] = useState(false);
  // Cases of a switched-off location (notifications off, marked purgeable):
  // the striped rows of every location table - the store, until it answers
  // the case's own notification switch.
  const { flagsOf } = useLocationFlags(cases.map((row) => row.location_id));
  const flagsFor = (row: NotificationCase): LocationFlags => ({
    notifications_disabled: row.notifications_disabled,
    purgeable: null,
    ...flagsOf(row.location_id),
  });

  const fetchCases = useCallback(() => {
    const query = new URLSearchParams({ state });
    if (kind) {
      query.set('kind', kind);
    }
    void axiosConfig.perform_get(
      auth,
      `/v1/notification-case/?${query.toString()}`,
      (result) => {
        setCases((result?.data?.cases || []) as NotificationCase[]);
        setLoading(false);
      },
      (error) => {
        showRequestError(enqueueSnackbar, t('staff_notifications_load_error'), error);
        setLoading(false);
      },
    );
    void axiosConfig.perform_get(
      auth,
      '/v1/notification-case/summary/',
      (result) => setSummary(result?.data as Summary),
      () => undefined,
    );
  }, [auth, enqueueSnackbar, kind, state, t]);

  useEffect(() => {
    fetchCases();
  }, [fetchCases]);

  const openCase = (row: Pick<NotificationCase, 'id'>) => {
    void axiosConfig.perform_get(
      auth,
      `/v1/notification-case/${row.id}/`,
      (result) => setSelected(result?.data?.case as NotificationCase),
      (error) => showRequestError(enqueueSnackbar, t('staff_notifications_load_error'), error),
    );
  };

  // /staff/?case=<id> (e.g. from the Alarmablauf of /escalations/): that
  // case's detail right away, the list in view behind it.
  const [searchParams] = useSearchParams();
  const linkedCase = Number(searchParams.get('case'));
  useEffect(() => {
    if (!Number.isInteger(linkedCase) || linkedCase <= 0) {
      return;
    }
    openCase({ id: linkedCase });
    document.querySelector('[data-testid="staff-notifications"]')?.scrollIntoView({ block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedCase]);

  const act = (path: 'mute' | 'unmute' | 'close', body: Record<string, unknown>, message: string) => {
    if (!selected) {
      return;
    }
    setBusy(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/notification-case/${selected.id}/${path}/`,
      body,
      (result) => {
        setBusy(false);
        setSelected(result?.data?.case as NotificationCase);
        showSuccessBar(enqueueSnackbar, message);
        fetchCases();
      },
      (error) => {
        setBusy(false);
        showRequestError(enqueueSnackbar, t('staff_notifications_action_error'), error);
      },
    );
  };

  const allColumns = useMemo<TableColumn<NotificationCase>[]>(
    () => [
      {
        id: 'kind',
        name: t('staff_notifications_col_kind'),
        width: '100px',
        cell: (row) => (
          <Badge bg={row.kind === 'alarm' ? 'danger' : 'secondary'} {...repeatedTestId('staff-notifications-kind', row.id)}>
            {t(`notification_kind_${row.kind}`)}
          </Badge>
        ),
      },
      {
        id: 'project',
        name: t('staff_notifications_col_project'),
        selector: (row) => `${row.project_id ?? row.location_id} ${row.location_name}`,
        sortable: true,
        cell: (row) => (
          <span className="small">
            <LocationFlagIcons flags={flagsFor(row)} testKey={`case-${row.id}`} />
            <Link to={`/location/${row.location_id}/status`} onClick={(event) => event.stopPropagation()}>
              {row.project_id ?? row.location_id}
            </Link>{' '}
            {row.location_name}
          </span>
        ),
      },
      {
        id: 'phase',
        name: t('staff_notifications_col_phase'),
        width: '190px',
        cell: (row) => (
          <span className="d-flex flex-wrap gap-1" {...repeatedTestId('staff-notifications-phase', row.id)}>
            <Badge bg={PHASE_VARIANT[row.phase] || 'secondary'}>{t(`staff_notifications_phase_${row.phase}`)}</Badge>
            {row.unreachable_since && <Badge bg="danger">{t('staff_notifications_unreachable')}</Badge>}
            {row.acknowledged_at && row.state === 'open' && <Badge bg="info" text="dark">{t('staff_notifications_acknowledged')}</Badge>}
          </span>
        ),
      },
      {
        id: 'stage',
        name: t('staff_notifications_col_stage'),
        width: '80px',
        selector: (row) => row.stage,
        sortable: true,
        format: (row) => `${row.stage}/${row.stages}`,
      },
      {
        id: 'opened',
        name: t('staff_notifications_col_opened'),
        width: '140px',
        selector: (row) => row.opened_at || '',
      },
      {
        id: 'next',
        name: t('staff_notifications_col_next'),
        width: '140px',
        selector: (row) => (row.state === 'open' ? row.next_contact_at || '-' : row.resolved_at || '-'),
      },
    ],
    // flagsFor reads the flags store - a new value re-renders this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, flagsOf],
  );
  // Phones: kind, project in the row, the rest in the row's expander.
  const { columns, expandable } = useMobileColumns(allColumns, ['kind', 'project']);

  const offline = summary?.counts.offline;
  const alarm = summary?.counts.alarm;
  const summaryKinds = [['offline', offline], ['alarm', alarm]] as const;
  const isPhone = useIsMobile();

  return (
    <Card className="border-0 shadow-sm my-4 p-3" data-testid="staff-notifications">
      <Card.Body>
        <div className="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
          <h5 className="mb-0">
            <BellFill className="me-2 text-warning" />
            {t('staff_notifications_title')}
          </h5>
          <Button variant="outline-secondary" size="sm" onClick={fetchCases} data-testid="staff-notifications-refresh">
            <ArrowRepeat className="me-1" />
            {t('staff_refresh')}
          </Button>
        </div>

        {summary && (
          <>
            <div className="d-flex flex-wrap gap-2 mb-2" data-testid="staff-notifications-modes">
              <Badge bg={summary.in_window ? 'success' : 'secondary'}>
                {summary.in_window ? t('staff_notifications_in_window') : t('staff_notifications_quiet_hours')}
              </Badge>
              {!summary.baseline_done && <Badge bg="info" text="dark">{t('staff_notifications_no_baseline')}</Badge>}
              {summary.no_recipients_left > 0 && (
                <Badge bg="danger">{t('staff_notifications_no_recipients_left', { count: summary.no_recipients_left })}</Badge>
              )}
            </div>
            {summary.locations && (
              <div className="staff-notifications-switch small mb-3" data-testid="staff-notifications-switch">
                <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
                  <Badge
                    bg={summary.locations.enabled ? 'success' : 'secondary'}
                    data-testid="staff-notifications-switch-enabled"
                  >
                    {t('staff_notifications_switch_enabled', {
                      enabled: summary.locations.enabled,
                      total: summary.locations.enabled + summary.locations.disabled,
                    })}
                  </Badge>
                  {(summary.withheld_last_day ?? 0) > 0 && (
                    <Badge bg="warning" text="dark" data-testid="staff-notifications-switch-withheld">
                      {t('staff_notifications_switch_withheld', { count: summary.withheld_last_day })}
                    </Badge>
                  )}
                  <Link to="/device/statistics/" data-testid="staff-notifications-switch-link">
                    {t('staff_notifications_switch_link')}
                  </Link>
                </div>
                <ul className="staff-notifications-switch-logic mb-0">
                  <li>{t('staff_notifications_switch_logic_created')}</li>
                  <li>{t('staff_notifications_switch_logic_sent')}</li>
                  <li>{t('staff_notifications_switch_logic_system')}</li>
                  <li>{t('staff_notifications_switch_logic_test')}</li>
                </ul>
              </div>
            )}
            {/* Ten phase columns: on phones turned on its side (a phase per
                row, offline / alarm as the two columns) so it fits; wider
                screens that still cut it off show the scroll cue. */}
            <ScrollShadow className="mb-3" testId="staff-notifications-summary-scroll">
              {isPhone ? (
                <Table size="sm" bordered className="small staff-notifications-summary" data-testid="staff-notifications-summary">
                  <thead>
                    <tr>
                      <th />
                      {summaryKinds.map(([name]) => (
                        <th key={name} {...repeatedTestId('staff-notifications-summary-row', name)}>
                          {t(`notification_kind_${name}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {SUMMARY_PHASES.map((phase) => (
                      <tr key={phase}>
                        <th>{t(`staff_notifications_phase_${phase}`)}</th>
                        {summaryKinds.map(([name, counts]) => (
                          <td key={name}>{counts?.[phase] ?? 0}</td>
                        ))}
                      </tr>
                    ))}
                    <tr>
                      <th>{t('staff_notifications_resolved_day')}</th>
                      {summaryKinds.map(([name]) => (
                        <td key={name}>{summary.resolved_last_day[name] ?? 0}</td>
                      ))}
                    </tr>
                  </tbody>
                </Table>
              ) : (
                <Table size="sm" bordered className="small staff-notifications-summary" data-testid="staff-notifications-summary">
                  <thead>
                    <tr>
                      <th />
                      {SUMMARY_PHASES.map((phase) => (
                        <th key={phase}>{t(`staff_notifications_phase_${phase}`)}</th>
                      ))}
                      <th>{t('staff_notifications_resolved_day')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summaryKinds.map(([name, counts]) => (
                      <tr key={name} {...repeatedTestId('staff-notifications-summary-row', name)}>
                        <th>{t(`notification_kind_${name}`)}</th>
                        {SUMMARY_PHASES.map((phase) => (
                          <td key={phase}>{counts?.[phase] ?? 0}</td>
                        ))}
                        <td>{summary.resolved_last_day[name] ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </ScrollShadow>
          </>
        )}

        <div className="d-flex flex-wrap gap-2 mb-2">
          <Form.Select
            size="sm"
            className="staff-notifications-filter"
            value={state}
            onChange={(event) => setState(event.target.value as typeof state)}
            data-testid="staff-notifications-state"
          >
            <option value="open">{t('staff_notifications_state_open')}</option>
            <option value="resolved">{t('staff_notifications_state_resolved')}</option>
            <option value="all">{t('staff_notifications_state_all')}</option>
          </Form.Select>
          <Form.Select
            size="sm"
            className="staff-notifications-filter"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
            data-testid="staff-notifications-kind-filter"
          >
            <option value="">{t('staff_notifications_kind_all')}</option>
            <option value="offline">{t('notification_kind_offline')}</option>
            <option value="alarm">{t('notification_kind_alarm')}</option>
          </Form.Select>
          <span className="small staff-notifications-legend" data-testid="staff-notifications-legend">
            <span className={`staff-notifications-legend-swatch ${LOCATION_OFF_CLASS}`} aria-hidden="true" />
            {t('location_flag_legend')}
            <BellSlashFill size={11} className="ms-2 me-1" />
            {t('location_flag_notifications_off')}
            <Trash3Fill size={11} className="ms-2 me-1" />
            {t('location_flag_purgeable')}
          </span>
        </div>

        <DataTable
          columns={columns}
          data={cases}
          {...expandable}
          pagination
          paginationPerPage={15}
          progressPending={loading}
          progressComponent={
            <div className="d-flex align-items-center gap-2 text-muted py-4">
              <Spinner size="sm" animation="border" />
              {t('staff_loading')}
            </div>
          }
          noDataComponent={<div className="text-muted py-3">{t('staff_notifications_empty')}</div>}
          onRowClicked={openCase}
          conditionalRowStyles={[locationOffRowStyle((row: NotificationCase) => isLocationOff(flagsFor(row)))]}
          highlightOnHover
          pointerOnHover
          dense
        />
      </Card.Body>

      <Modal
        show={selected != null}
        onHide={() => {
          setSelected(null);
          setAskClose(false);
        }}
        size="lg"
        data-testid="staff-notifications-detail"
      >
        {selected && (
          <>
            <Modal.Header closeButton>
              <Modal.Title className="fs-6">
                {t(`notification_kind_${selected.kind}`)} · {selected.project_id ?? selected.location_id} {selected.location_name}
              </Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <dl className="row small mb-3 staff-notifications-facts">
                <dt className="col-4">{t('staff_notifications_col_phase')}</dt>
                <dd className="col-8">
                  <Badge bg={PHASE_VARIANT[selected.phase] || 'secondary'}>{t(`staff_notifications_phase_${selected.phase}`)}</Badge>{' '}
                  {t('staff_notifications_stage_of', { stage: selected.stage, stages: selected.stages })}
                </dd>
                <dt className="col-4">{t('staff_notifications_col_opened')}</dt>
                <dd className="col-8">{selected.opened_at || '-'}</dd>
                <dt className="col-4">{t('staff_notifications_col_next')}</dt>
                <dd className="col-8">{selected.next_contact_at || '-'}</dd>
                {selected.muted && (
                  <>
                    <dt className="col-4">{t('staff_notifications_muted_until')}</dt>
                    <dd className="col-8">{selected.muted_until}</dd>
                  </>
                )}
                {selected.escalation_id && (
                  <>
                    <dt className="col-4">{t('staff_notifications_escalation')}</dt>
                    <dd className="col-8">#{selected.escalation_id}</dd>
                  </>
                )}
                <dt className="col-4">{t('staff_notifications_notified')}</dt>
                <dd className="col-8">{selected.notified.join(', ') || '-'}</dd>
                {selected.kind === 'offline' && (
                  <>
                    <dt className="col-4">{t('staff_notifications_devices')}</dt>
                    <dd className="col-8">
                      {selected.devices.map((device) => (
                        <div key={device.id}>
                          {device.label} - {t('staff_notifications_last_seen', { at: device.last_seen || '-' })}
                          {device.back_since && <Badge bg="success" className="ms-1">{t('staff_notifications_back')}</Badge>}
                        </div>
                      ))}
                    </dd>
                  </>
                )}
                {selected.kind === 'alarm' && (
                  <>
                    <dt className="col-4">{t('staff_notifications_alarms')}</dt>
                    <dd className="col-8">{selected.alarm_count}</dd>
                  </>
                )}
              </dl>
              <h6>{t('staff_notifications_protocol')}</h6>
              <Table size="sm" className="small" data-testid="staff-notifications-events">
                <tbody>
                  {(selected.events || []).map((entry) => (
                    <tr key={entry.id} {...repeatedTestId('staff-notifications-event', entry.id)}>
                      <td className="text-nowrap text-muted">{entry.created}</td>
                      <td className="text-nowrap">{t(`staff_notifications_event_${entry.kind}`)}</td>
                      <td>{entry.text}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Modal.Body>
            {selected.state === 'open' && (
              <Modal.Footer>
                <ButtonGroup size="sm">
                  {selected.muted ? (
                    <Button
                      variant="outline-primary"
                      disabled={busy}
                      onClick={() => act('unmute', {}, t('staff_notifications_unmuted'))}
                      data-testid="staff-notifications-unmute"
                    >
                      {t('staff_notifications_unmute')}
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="outline-secondary"
                        disabled={busy}
                        onClick={() => act('mute', { days: 7 }, t('staff_notifications_muted'))}
                        data-testid="staff-notifications-mute-week"
                      >
                        {t('staff_notifications_mute_week')}
                      </Button>
                      <Button
                        variant="outline-secondary"
                        disabled={busy}
                        onClick={() => act('mute', { days: null }, t('staff_notifications_muted'))}
                        data-testid="staff-notifications-mute"
                      >
                        {t('staff_notifications_mute')}
                      </Button>
                    </>
                  )}
                </ButtonGroup>
                <Button
                  variant="outline-danger"
                  size="sm"
                  disabled={busy}
                  onClick={() => setAskClose(true)}
                  data-testid="staff-notifications-close"
                >
                  {t('staff_notifications_close')}
                </Button>
              </Modal.Footer>
            )}
            <ConfirmDialog
              show={askClose}
              title={t('staff_notifications_close_confirm_title')}
              message={t('staff_notifications_close_confirm', {
                kind: t(`notification_kind_${selected.kind}`),
                location: `${selected.project_id ?? selected.location_id} ${selected.location_name}`,
              })}
              confirmLabel={t('staff_notifications_close')}
              cancelLabel={t('staff_cancel')}
              onConfirm={() => {
                setAskClose(false);
                act('close', {}, t('staff_notifications_closed'));
              }}
              onCancel={() => setAskClose(false)}
              testId="staff-notifications-close-dialog"
            />
          </>
        )}
      </Modal>
    </Card>
  );
};

export default StaffNotificationCases;
