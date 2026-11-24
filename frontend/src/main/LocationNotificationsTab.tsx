import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router';
import { Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showRequestError, showSuccessBar } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import PillButton from '../components/ui/kit/PillButton';
import ConfirmDialog from '../components/ui/kit/ConfirmDialog';
import SeverityBadge, { type Severity } from '../components/ui/kit/SeverityBadge';
import { useProgeoRole } from './roleModel';
import type { PortalOutletContext } from './LocationPortalLayout';
import { formatDate } from './dateFormat';
import { repeatedTestId } from '../testIds';
import MatrixPromoBanner from './MatrixPromoBanner';
import './LocationNotificationsTab.css';
import { projectPath } from './portalNav';

type TimelineEvent = {
  kind: 'email' | 'sms' | 'messenger' | 'alarm_triggered' | 'alarm_acknowledged' | 'alarm_resolved';
  at: string;
  title?: string | null;
  detail?: string | number | null;
  success?: boolean;
  error?: string | null;
  severity?: Severity;
  max_value?: number | null;
  /** Number of flapping alarms merged into this triggered event. */
  occurrences?: number;
};

type TestRecipient = {
  user_id: number;
  name: string;
  mail: string | null;
  mobile: string | null;
  messenger: { service: string; address: string } | null;
  kanal: string;
};

const DAYS_WINDOW = 90;

/**
 * Status -> Heatmap at the time of an event (`?at=<ISO>`, read by the
 * status view): a click on an event of the history opens it there.
 */
const statusAtPath = (projectId: string | number, at: string) =>
  projectPath(projectId, 'status', `at=${encodeURIComponent(at)}`);

/** Messenger events carry the service (signal/whatsapp/matrix) as title. */
const MESSENGER_LABELS: Record<string, string> = { signal: 'Signal', whatsapp: 'WhatsApp', matrix: 'Matrix' };

/**
 * Benachrichtigungen (Ereignisverlauf): a real chronological feed of what
 * happened for this location, backed by LocationViewSet.timeline (merges
 * EMail sends and ProgeoAlarm lifecycle events). Per-recipient delivery/read
 * receipts and SMS logging don't exist in the backend, so this shows what
 * actually happened (sent/failed, triggered/acknowledged/resolved) rather
 * than the finer-grained delivery table the mockup shows.
 */
const LocationNotificationsTab = () => {
  const { location, locationId } = useOutletContext<PortalOutletContext>();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  const isStaff = useProgeoRole() === 'progeo-admin';
  const [testOpen, setTestOpen] = useState(false);
  const [testRecipients, setTestRecipients] = useState<TestRecipient[]>([]);
  const [testSending, setTestSending] = useState(false);

  const openTest = () => {
    setTestOpen(true);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/test_notification/`,
      (response) => {
        setTestRecipients((response?.data?.recipients || []) as TestRecipient[]);
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not load recipients', error);
      },
    );
  };

  const sendTest = () => {
    setTestSending(true);
    void axiosConfig.perform_post(
      auth,
      `/v1/location/${locationId}/test_notification/`,
      {},
      (response) => {
        const results = (response?.data?.results || []) as {
          name: string;
          email_ok?: boolean;
          sms_ok?: boolean;
          messenger_ok?: boolean;
        }[];
        const okCount = results.filter((r) => r.email_ok || r.sms_ok || r.messenger_ok).length;
        setTestSending(false);
        setTestOpen(false);
        showSuccessBar(
          enqueueSnackbar,
          t('benach_test_sent', { ok: okCount, total: results.length }),
        );
        load();
      },
      (error) => {
        showRequestError(enqueueSnackbar, 'Could not send test notification', error);
        setTestSending(false);
      },
    );
  };

  const load = useCallback(() => {
    setLoading(true);
    setDenied(false);
    void axiosConfig.perform_get(
      auth,
      `/v1/location/${locationId}/timeline/?days=${DAYS_WINDOW}`,
      (response) => {
        setEvents((response?.data?.events || []) as TimelineEvent[]);
        setLoading(false);
      },
      (error) => {
        if (error?.response?.status === 403) {
          setDenied(true);
        } else {
          showRequestError(enqueueSnackbar, 'Could not load event history', error);
        }
        setLoading(false);
      },
    );
  }, [auth, enqueueSnackbar, locationId]);

  useEffect(() => {
    load();
  }, [load]);

  const eventTitle = (event: TimelineEvent): string => {
    switch (event.kind) {
      case 'email':
        return event.title || t('benach_event_email');
      case 'sms':
        return t('benach_event_sms');
      case 'messenger':
        return t('benach_event_messenger', { service: MESSENGER_LABELS[event.title || ''] || event.title });
      case 'alarm_triggered':
        return t('benach_event_triggered');
      case 'alarm_acknowledged':
        return t('benach_event_acknowledged');
      case 'alarm_resolved':
        return t('benach_event_resolved');
      default:
        return event.kind;
    }
  };

  const eventDetail = (event: TimelineEvent): string | null => {
    if (event.kind === 'email' || event.kind === 'sms' || event.kind === 'messenger') {
      return event.success
        ? t('benach_email_sent_to', { recipients: event.detail })
        : t('benach_email_failed', { recipients: event.detail, reason: event.error || '?' });
    }
    if (event.kind === 'alarm_triggered') {
      const parts = [
        event.max_value != null
          ? t('benach_sensor_reading', { sensor: event.detail, value: Math.round(event.max_value) })
          : null,
        event.occurrences && event.occurrences > 1
          ? t('benach_occurrences', { count: event.occurrences })
          : null,
      ].filter(Boolean);
      return parts.length ? parts.join(' · ') : null;
    }
    if (event.kind === 'alarm_acknowledged') {
      return event.detail ? t('benach_acknowledged_by', { name: event.detail }) : null;
    }
    return null;
  };

  const dotColor = (event: TimelineEvent): string => {
    if (event.kind === 'email' || event.kind === 'sms' || event.kind === 'messenger') {
      return event.success ? '#3F7A1C' : '#C44D26';
    }
    if (event.kind === 'alarm_resolved') {
      return '#3F7A1C';
    }
    if (event.kind === 'alarm_acknowledged') {
      return '#6E6868';
    }
    return 'var(--progeo-orange)';
  };

  return (
    <div className="benach-page">
    <MatrixPromoBanner />
    <PanelCard
      testId="page-location-benachrichtigungen"
      title={t('benach_title')}
      actions={
        isStaff && (
          <PillButton
            variant="accent"
            onClick={openTest}
            testId="benach-test-button"
            icon={
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 2.7s-6 6.6-6 11.3a6 6 0 0 0 12 0c0-4.7-6-11.3-6-11.3z" />
              </svg>
            }
            label={t('benach_test_button')}
          />
        )
      }
    >
      {loading ? (
        <div className="d-flex justify-content-center py-4 text-muted" data-testid="benach-loading">
          <Spinner animation="border" size="sm" />
        </div>
      ) : denied ? (
        <div className="benach-denied" data-testid="benach-denied">{t('status_no_measurement_access')}</div>
      ) : events.length === 0 ? (
        <div className="benach-empty" data-testid="benach-empty">
          {t('benach_empty')}
        </div>
      ) : (
        <div className="benach-events" data-testid="benach-events">
          {events.map((event, index) => (
            <button
              type="button"
              key={index}
              className="benach-event"
              disabled={!event.at}
              title={event.at ? t('benach_event_open_status') : undefined}
              onClick={() =>
                event.at && location?.project_id != null && navigate(statusAtPath(location.project_id, event.at))
              }
              // Events have no id: the position in the feed tells them apart.
              {...repeatedTestId('benach-event', index)}
            >
              <span className="benach-event-dot" style={{ background: dotColor(event) }} />
              <span className="benach-event-body">
                <span className="benach-event-head">
                  <span className="benach-event-title">{eventTitle(event)}</span>
                  {event.severity && <SeverityBadge severity={event.severity} label={t(`ui_severity_${event.severity}`)} />}
                  <span className="benach-event-time">
                    {formatDate(event.at)}
                  </span>
                </span>
                {eventDetail(event) && (
                  <span className="benach-event-detail">
                    {eventDetail(event)}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </PanelCard>
    <ConfirmDialog
      testId="benach-test-dialog"
      show={testOpen}
      title={t('benach_test_title')}
      danger={false}
      confirmLabel={t('benach_test_send')}
      cancelLabel={t('rechte_cancel')}
      confirming={testSending}
      onCancel={() => setTestOpen(false)}
      onConfirm={sendTest}
      message={
        <div className="benach-test-body">
          <div>{t('benach_test_description')}</div>
          {testRecipients.length === 0 ? (
            <div className="benach-muted" data-testid="benach-test-no-recipients">
              {t('benach_test_no_recipients')}
            </div>
          ) : (
            <div className="benach-recipients" data-testid="benach-test-recipients">
              {testRecipients.map((recipient) => (
                <div
                  key={recipient.user_id}
                  className="benach-recipient"
                  {...repeatedTestId('benach-test-recipient', recipient.user_id)}
                >
                  <span>{recipient.name}</span>
                  <span className="benach-muted">{recipient.kanal}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      }
    />
    </div>
  );
};

export default LocationNotificationsTab;
