import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Spinner, Table } from 'react-bootstrap';
import { ArrowRepeat, Envelope, Trash } from 'react-bootstrap-icons';
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

type MessageStatus =
  | 'sent'
  | 'redirected'
  | 'dry_run'
  | 'rate_limited'
  | 'suppressed'
  | 'blocked'
  | 'failed'
  | 'bounced';

type OutboundMessage = {
  id: number;
  channel: 'mail' | 'sms';
  status: MessageStatus;
  category: string;
  recipient: string;
  actual_recipient: string;
  subject: string;
  created: string | null;
  error: string | null;
  bounce_reason: string | null;
};

type Suppression = {
  id: number;
  address: string;
  reason: string;
  bounce_count: number;
  last_bounce_at: string | null;
  created: string | null;
};

type MessagingState = {
  mailing_enabled: boolean;
  mail_test_mode: boolean;
  mail_test_recipient: string;
  sms_dry_run: boolean;
  breaker: {
    tripped: boolean;
    tripped_at: string | null;
    reason: string | null;
  };
  limits: Record<string, number>;
  counts: { mail_last_hour: number; sms_last_hour: number; sms_today: number };
  messages: OutboundMessage[];
  suppressions: Suppression[];
};

const STATUS_VARIANT: Record<MessageStatus, string> = {
  sent: 'success',
  redirected: 'info',
  dry_run: 'info',
  rate_limited: 'warning',
  suppressed: 'warning',
  blocked: 'danger',
  failed: 'danger',
  bounced: 'danger',
};

/**
 * "Versand (E-Mail/SMS)" in the staff admin: the safety switches of this
 * server (test mode, SMS dry run), the emergency brake that stops every
 * send once a global limit was hit, recent sends and the addresses that
 * bounced and get no more mail.
 */
const StaffMessaging = () => {
  const { t } = useTranslation();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const [state, setState] = useState<MessagingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // `loading` is only the first load's spinner - a refresh keeps the shown state.
  const fetchState = useCallback(() => {
    void axiosConfig.perform_get(
      auth,
      '/api/auth-support/staff/messaging/',
      (result) => {
        setState(result?.data as MessagingState);
        setLoading(false);
      },
      (error) => {
        showRequestError(
          enqueueSnackbar,
          t('staff_messaging_load_error'),
          error,
        );
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar, t]);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  const post = (url: string, successMessage: string) => {
    setBusy(true);
    void axiosConfig.perform_post(
      auth,
      url,
      {},
      () => {
        showSuccessBar(enqueueSnackbar, successMessage);
        setBusy(false);
        fetchState();
      },
      (error) => {
        showRequestError(
          enqueueSnackbar,
          t('staff_messaging_action_error'),
          error,
        );
        setBusy(false);
      },
    );
  };

  const resetBreaker = () => {
    if (window.confirm(t('staff_messaging_breaker_reset_confirm'))) {
      post(
        '/api/auth-support/staff/messaging/breaker/reset/',
        t('staff_messaging_breaker_reset_done'),
      );
    }
  };

  const deleteSuppression = (suppression: Suppression) => {
    if (
      window.confirm(
        t('staff_messaging_suppression_delete_confirm', {
          address: suppression.address,
        }),
      )
    ) {
      post(
        `/api/auth-support/staff/messaging/suppressions/${suppression.id}/delete/`,
        t('staff_messaging_suppression_deleted'),
      );
    }
  };

  const columns = useMemo<TableColumn<OutboundMessage>[]>(
    () => [
      {
        name: t('staff_messaging_col_created'),
        selector: (row) => row.created || '',
        sortable: true,
        width: '140px',
      },
      {
        name: t('staff_messaging_col_channel'),
        width: '80px',
        cell: (row) => (
          <Badge bg={row.channel === 'sms' ? 'dark' : 'primary'}>
            {row.channel === 'sms' ? 'SMS' : 'Mail'}
          </Badge>
        ),
      },
      {
        name: t('staff_messaging_col_status'),
        width: '130px',
        cell: (row) => (
          <Badge bg={STATUS_VARIANT[row.status] || 'secondary'}>
            {t(`staff_messaging_status_${row.status}`)}
          </Badge>
        ),
      },
      {
        name: t('staff_messaging_col_category'),
        selector: (row) => row.category,
        sortable: true,
        width: '130px',
      },
      {
        name: t('staff_messaging_col_recipient'),
        cell: (row) => (
          <span className="small">
            {row.recipient}
            {row.actual_recipient && row.actual_recipient !== row.recipient && (
              <>
                <br />
                <span className="text-muted">→ {row.actual_recipient}</span>
              </>
            )}
          </span>
        ),
      },
      {
        name: t('staff_messaging_col_subject'),
        cell: (row) => {
          const problem = row.bounce_reason || row.error;
          return (
            <span className="small">
              {row.subject || '-'}
              {problem && (
                <>
                  <br />
                  <span className="text-danger">{problem}</span>
                </>
              )}
            </span>
          );
        },
      },
    ],
    [t],
  );

  if (loading && !state) {
    return (
      <Card className="border-0 shadow-sm my-4 p-3">
        <Card.Body className="d-flex align-items-center gap-2 text-muted">
          <Spinner size="sm" animation="border" />
          {t('staff_loading')}
        </Card.Body>
      </Card>
    );
  }

  if (!state) {
    return null;
  }

  return (
    <Card className="border-0 shadow-sm my-4 p-3">
      <Card.Body>
        <div className="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
          <h5 className="mb-0">
            <Envelope className="me-2 text-warning" />
            {t('staff_messaging_title')}
          </h5>
          <Button variant="outline-secondary" size="sm" onClick={fetchState}>
            <ArrowRepeat className="me-1" />
            {t('staff_refresh')}
          </Button>
        </div>

        <div className="d-flex flex-wrap gap-2 mb-3">
          {!state.mailing_enabled && (
            <Badge bg="secondary">
              {t('staff_messaging_mailing_disabled')}
            </Badge>
          )}
          {state.mail_test_mode ? (
            <Badge bg="info" text="dark">
              {t('staff_messaging_test_mode', {
                recipient: state.mail_test_recipient,
              })}
            </Badge>
          ) : (
            <Badge bg="success">{t('staff_messaging_live_mode')}</Badge>
          )}
          {state.sms_dry_run ? (
            <Badge bg="info" text="dark">
              {t('staff_messaging_sms_dry_run')}
            </Badge>
          ) : (
            <Badge bg="success">{t('staff_messaging_sms_live')}</Badge>
          )}
        </div>

        {state.breaker.tripped && (
          <Alert
            variant="danger"
            className="d-flex flex-wrap justify-content-between align-items-center gap-2"
          >
            <span>
              <strong>{t('staff_messaging_breaker_tripped')}</strong>{' '}
              {state.breaker.tripped_at || ''}
              {state.breaker.reason && <> - {state.breaker.reason}</>}
            </span>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={resetBreaker}
            >
              {t('staff_messaging_breaker_reset')}
            </Button>
          </Alert>
        )}

        <Table
          size="sm"
          bordered
          className="mb-4 small"
          style={{ maxWidth: 560 }}
        >
          <tbody>
            <tr>
              <th>{t('staff_messaging_count_mail_hour')}</th>
              <td>{state.counts.mail_last_hour}</td>
            </tr>
            <tr>
              <th>{t('staff_messaging_count_sms_hour')}</th>
              <td>{state.counts.sms_last_hour}</td>
            </tr>
            <tr>
              <th>{t('staff_messaging_count_sms_today')}</th>
              <td>{state.counts.sms_today}</td>
            </tr>
            {Object.entries(state.limits).map(([name, value]) => (
              <tr key={name}>
                <th className="fw-normal text-muted">{name}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </Table>

        <h6>{t('staff_messaging_recent')}</h6>
        <DataTable
          columns={columns}
          data={state.messages}
          pagination
          paginationPerPage={15}
          noDataComponent={
            <div className="text-muted py-4">
              {t('staff_messaging_no_messages')}
            </div>
          }
          dense
          highlightOnHover
        />

        <h6 className="mt-4">{t('staff_messaging_suppressions')}</h6>
        <p className="text-muted small">
          {t('staff_messaging_suppressions_hint')}
        </p>
        {state.suppressions.length === 0 ? (
          <p className="text-muted small">
            {t('staff_messaging_no_suppressions')}
          </p>
        ) : (
          <Table size="sm" hover className="small">
            <thead>
              <tr>
                <th>{t('staff_messaging_col_address')}</th>
                <th>{t('staff_messaging_col_reason')}</th>
                <th>{t('staff_messaging_col_bounces')}</th>
                <th>{t('staff_messaging_col_last_bounce')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.suppressions.map((suppression) => (
                <tr key={suppression.id}>
                  <td>{suppression.address}</td>
                  <td>{suppression.reason}</td>
                  <td>{suppression.bounce_count}</td>
                  <td>{suppression.last_bounce_at || '-'}</td>
                  <td className="text-end">
                    <Button
                      size="sm"
                      variant="outline-danger"
                      title={t('staff_messaging_suppression_delete')}
                      disabled={busy}
                      onClick={() => deleteSuppression(suppression)}
                    >
                      <Trash size={14} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card.Body>
    </Card>
  );
};

export default StaffMessaging;
