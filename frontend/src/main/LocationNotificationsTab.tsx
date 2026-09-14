import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router';
import { Spinner } from 'react-bootstrap';
import { useSnackbar } from 'notistack';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/CoreAuthProvider.tsx';
import axiosConfig from '../axiosConfig';
import { showErrorBar } from '../components/ui/Snackbar.jsx';
import PanelCard from '../components/ui/kit/PanelCard';
import SeverityBadge, { type Severity } from '../components/ui/kit/SeverityBadge';
import type { PortalOutletContext } from './LocationPortalLayout';

type TimelineEvent = {
  kind: 'email' | 'alarm_triggered' | 'alarm_acknowledged' | 'alarm_resolved';
  at: string;
  title?: string | null;
  detail?: string | number | null;
  success?: boolean;
  error?: string | null;
  severity?: Severity;
  max_value?: number | null;
};

const DAYS_WINDOW = 90;

/**
 * Benachrichtigungen (Ereignisverlauf): a real chronological feed of what
 * happened for this location, backed by LocationViewSet.timeline (merges
 * EMail sends and ProgeoAlarm lifecycle events). Per-recipient delivery/read
 * receipts and SMS logging don't exist in the backend, so this shows what
 * actually happened (sent/failed, triggered/acknowledged/resolved) rather
 * than the finer-grained delivery table the mockup shows.
 */
const LocationNotificationsTab = () => {
  const { locationId } = useOutletContext<PortalOutletContext>();
  const auth = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslation();

  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

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
          const reason = error?.response?.data?.reason || error.message;
          showErrorBar(enqueueSnackbar, `Could not load event history: ${reason}`);
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
    if (event.kind === 'email') {
      return event.success
        ? t('benach_email_sent_to', { recipients: event.detail })
        : t('benach_email_failed', { recipients: event.detail, reason: event.error || '?' });
    }
    if (event.kind === 'alarm_triggered') {
      return event.max_value != null
        ? t('benach_sensor_reading', { sensor: event.detail, value: Math.round(event.max_value) })
        : null;
    }
    if (event.kind === 'alarm_acknowledged') {
      return event.detail ? t('benach_acknowledged_by', { name: event.detail }) : null;
    }
    return null;
  };

  const dotColor = (event: TimelineEvent): string => {
    if (event.kind === 'email') {
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
    <PanelCard title={t('benach_title')}>
      {loading ? (
        <div className="d-flex justify-content-center py-4 text-muted">
          <Spinner animation="border" size="sm" />
        </div>
      ) : denied ? (
        <div style={{ color: '#8B8383', fontSize: 13 }}>{t('status_no_measurement_access')}</div>
      ) : events.length === 0 ? (
        <div
          style={{
            background: 'var(--progeo-surface)',
            borderRadius: 14,
            padding: '22px 16px',
            fontSize: 13,
            color: '#8B8383',
          }}
        >
          {t('benach_empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {events.map((event, index) => (
            <div
              key={index}
              style={{
                display: 'flex',
                gap: 14,
                padding: '15px 4px',
                borderTop: index > 0 ? '1px solid var(--progeo-track)' : 'none',
              }}
            >
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  background: dotColor(event),
                  flexShrink: 0,
                  marginTop: 5,
                }}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>{eventTitle(event)}</span>
                  {event.severity && <SeverityBadge severity={event.severity} label={t(`ui_severity_${event.severity}`)} />}
                  <span style={{ fontSize: 12, color: '#8B8383' }}>
                    {new Date(event.at).toLocaleString()}
                  </span>
                </span>
                {eventDetail(event) && (
                  <span style={{ display: 'block', marginTop: 4, fontSize: 13, color: '#6E6868' }}>
                    {eventDetail(event)}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </PanelCard>
  );
};

export default LocationNotificationsTab;
