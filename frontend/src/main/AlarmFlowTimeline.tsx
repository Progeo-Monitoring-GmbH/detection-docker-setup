import type { ReactNode } from 'react';
import { Badge } from 'react-bootstrap';
import {
  ChatDotsFill,
  CheckLg,
  EnvelopeFill,
  ExclamationTriangleFill,
  PauseFill,
  PeopleFill,
  PhoneFill,
} from 'react-bootstrap-icons';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { formatDate } from './dateFormat';
import {
  durationParts,
  mailOutcome,
  minutesUntil,
  nowIndex,
  relativeDay,
  type FlowCase,
  type FlowChannel,
  type FlowPlanned,
  type FlowPoint,
  type FlowSent,
} from './alarmFlow';
import { statusViewPath } from './statusViewState';
import { repeatedTestId } from '../testIds';
import './AlarmFlow.css';

type T = ReturnType<typeof useTranslation>['t'];

/** Recipients shown per card - the rest as "+ n weitere" (all in the tooltip). */
const SHOWN_RECIPIENTS = 5;

const CHANNEL_ICONS: Record<FlowChannel, ReactNode> = {
  mail: <EnvelopeFill aria-hidden />,
  sms: <PhoneFill aria-hidden />,
  messenger: <ChatDotsFill aria-hidden />,
};

/** "heute 18:05" / "morgen 14:05" / "24.11. 09:00". */
export const whenText = (iso: string, now: number, t: T) => {
  const day = relativeDay(iso, now);
  return day ? t(`flow_day_${day}`, { time: formatDate(iso, 'time') }) : formatDate(iso, 'dayMonthTime');
};

/** "1 h 40 min" / "3 Tg 2 h" / "7 min". */
export const durationText = (minutes: number, t: T) => {
  const parts = durationParts(minutes);
  if ('days' in parts) {
    return t('flow_duration_dh', parts);
  }
  return 'hours' in parts ? t('flow_duration_hm', parts) : t('flow_duration_m', parts);
};

const Chip = ({ icon, children, tone }: { icon?: ReactNode; children: ReactNode; tone?: 'fail' | 'warn' }) => (
  <span className={tone ? `alarm-flow-chip alarm-flow-chip--${tone}` : 'alarm-flow-chip'}>
    {icon}
    {children}
  </span>
);

const SentCard = ({ point, t }: { point: FlowSent; t: T }) => {
  const delivered = point.mails.filter((mail) => mailOutcome(mail.status) === 'ok').length;
  const failed = point.mails.filter((mail) => mailOutcome(mail.status) === 'fail').length;
  const shown = point.mails.slice(0, SHOWN_RECIPIENTS);
  return (
    <div className="alarm-flow-card">
      {point.withheld ? (
        <Chip tone="warn">{t('flow_withheld_sent')}</Chip>
      ) : (
        <>
          {point.mails.length > 0 && <Chip icon={CHANNEL_ICONS.mail}>{delivered}</Chip>}
          {point.sms > 0 && <Chip icon={CHANNEL_ICONS.sms}>{point.sms}</Chip>}
          {point.messenger > 0 && <Chip icon={CHANNEL_ICONS.messenger}>{point.messenger}</Chip>}
          {point.escalation && <Chip icon={<PeopleFill aria-hidden />}>{t('flow_escalation')}</Chip>}
          {failed > 0 && (
            <Chip tone="fail" icon={<ExclamationTriangleFill aria-hidden />}>
              {t('flow_failed_count', { count: failed })}
            </Chip>
          )}
        </>
      )}
      {shown.length > 0 && (
        <ul className="alarm-flow-people">
          {shown.map((mail) => (
            <li key={mail.address} title={mail.address}>
              <span className="alarm-flow-person">{mail.name}</span>
              <span className={`alarm-flow-mail alarm-flow-mail--${mailOutcome(mail.status)}`}>
                {t(`flow_mail_${mail.status}`, { defaultValue: mail.status })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {point.mails.length > SHOWN_RECIPIENTS && (
        <div className="alarm-flow-muted">{t('flow_more_recipients', { count: point.mails.length - SHOWN_RECIPIENTS })}</div>
      )}
      {!point.withheld && point.mails.length === 0 && point.sms + point.messenger === 0 && !point.escalation && (
        <div className="alarm-flow-muted">{t('flow_reached_nobody')}</div>
      )}
    </div>
  );
};

const PlannedCard = ({ point, t }: { point: FlowPlanned; t: T }) => {
  const shown = point.recipients.slice(0, SHOWN_RECIPIENTS);
  const rest = point.recipients.slice(SHOWN_RECIPIENTS);
  return (
    <div className="alarm-flow-card alarm-flow-card--planned">
      <div className="alarm-flow-card-title">
        {point.escalation && !point.customer
          ? t('flow_escalation')
          : point.stage === 1
            ? t('flow_planned_first')
            : t('flow_planned_reminder')}
      </div>
      {point.withheld && <Chip tone="warn">{t('flow_withheld_planned')}</Chip>}
      {point.objektleitung && <Chip>{t('flow_objektleitung')}</Chip>}
      {point.escalation && point.customer && <Chip icon={<PeopleFill aria-hidden />}>{t('flow_escalation')}</Chip>}
      {!point.customer && <div className="alarm-flow-muted">{t('flow_team_only')}</div>}
      {shown.length > 0 && (
        <ul className="alarm-flow-people">
          {shown.map((recipient) => (
            <li key={`${recipient.name}-${recipient.channels.join()}`}>
              <span className="alarm-flow-person">
                {recipient.name}
                {recipient.objektleitung && <span className="alarm-flow-muted"> ({t('flow_objektleitung_short')})</span>}
              </span>
              <span className="alarm-flow-channels" aria-label={recipient.channels.map((channel) => t(`flow_channel_${channel}`)).join(', ')}>
                {recipient.channels.map((channel) => (
                  <span key={channel}>{CHANNEL_ICONS[channel]}</span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
      {rest.length > 0 && (
        <div className="alarm-flow-muted" title={rest.map((recipient) => recipient.name).join(', ')}>
          {t('flow_more_recipients', { count: rest.length })}
        </div>
      )}
      {point.customer && point.recipients.length === 0 && (
        <div className="alarm-flow-muted">{t('flow_recipients_none')}</div>
      )}
    </div>
  );
};

/** The time line under a planned stage: countdown, overdue, paused. */
const plannedWhen = (point: FlowPlanned, now: number, t: T) => {
  if (!point.at) {
    return <span className="alarm-flow-paused"><PauseFill aria-hidden /> {t('flow_muted_forever')}</span>;
  }
  const minutes = minutesUntil(point.at, now);
  return (
    <>
      <div className="alarm-flow-when">{whenText(point.at, now, t)}</div>
      {point.paused && (
        <span className="alarm-flow-paused"><PauseFill aria-hidden /> {t('flow_paused')}</span>
      )}
      <div className={minutes <= 0 ? 'alarm-flow-countdown alarm-flow-countdown--due' : 'alarm-flow-countdown'}>
        {minutes <= 0 ? t('flow_overdue') : t('flow_in', { duration: durationText(minutes, t) })}
      </div>
    </>
  );
};

const Point = ({ flow, point, index, now, t }: { flow: FlowCase; point: FlowPoint; index: number; now: number; t: T }) => {
  const testId = repeatedTestId('alarm-flow-point', `${flow.id}-${index}`);
  if (point.type === 'detected') {
    return (
      <div className="alarm-flow-stop" {...testId}>
        <span className="alarm-flow-dot alarm-flow-dot--detected">!</span>
        <div className="alarm-flow-when">{whenText(point.at, now, t)}</div>
        <div className="alarm-flow-label">{t(`flow_detected_${flow.kind}`)}</div>
        <div className="alarm-flow-card">
          {flow.kind === 'alarm'
            ? t('flow_alarm_count', { count: flow.alarm_count })
            : t('flow_device_count', { count: flow.device_count })}
        </div>
      </div>
    );
  }
  if (point.type === 'sent') {
    return (
      <div className="alarm-flow-stop" {...testId}>
        <span className="alarm-flow-dot alarm-flow-dot--sent">{point.stage ?? '·'}</span>
        <div className="alarm-flow-when">{whenText(point.at, now, t)}</div>
        <div className={point.withheld ? 'alarm-flow-label' : 'alarm-flow-label alarm-flow-label--ok'}>
          {point.withheld
            ? t('flow_sent_withheld', { stage: point.stage })
            : point.escalation && point.mails.length === 0 && point.sms + point.messenger === 0
              ? t('flow_sent_escalation', { stage: point.stage })
              : t('flow_sent', { stage: point.stage })}
          {!point.withheld && <CheckLg aria-hidden className="ms-1" />}
        </div>
        <SentCard point={point} t={t} />
      </div>
    );
  }
  return (
    <div className="alarm-flow-stop alarm-flow-stop--planned" {...testId}>
      <span className="alarm-flow-dot alarm-flow-dot--planned">{point.stage}</span>
      {plannedWhen(point, now, t)}
      <div className="alarm-flow-label">{t('flow_planned', { stage: point.stage })}</div>
      <PlannedCard point={point} t={t} />
    </div>
  );
};

/** The "jetzt" marker and what holds the case right now. */
const NowMarker = ({ flow, now, t }: { flow: FlowCase; now: number; t: T }) => (
  <div className="alarm-flow-now" {...repeatedTestId('alarm-flow-now', flow.id)}>
    <span className="alarm-flow-now-pin" aria-hidden />
    <span className="alarm-flow-now-label">{t('flow_now', { time: formatDate(now, 'time') })}</span>
    <div className="alarm-flow-now-notes">
      {flow.kind === 'alarm' && <div>{t('flow_not_acknowledged')}</div>}
      {flow.kind === 'offline' && flow.acknowledged_at && (
        <div>{t('flow_acknowledged', { when: whenText(flow.acknowledged_at, now, t) })}</div>
      )}
      {flow.back_since && <div className="alarm-flow-ok">{t('flow_back_since', { when: whenText(flow.back_since, now, t) })}</div>}
      {flow.muted_until && !flow.muted_forever && (
        <div className="alarm-flow-paused">{t('flow_muted_until', { when: whenText(flow.muted_until, now, t) })}</div>
      )}
      {flow.unreachable_since && <div className="alarm-flow-fail">{t('flow_unreachable')}</div>}
    </div>
  </div>
);

const EndPoint = ({ flow, t }: { flow: FlowCase; t: T }) => (
  <div className="alarm-flow-stop alarm-flow-stop--end">
    <span className="alarm-flow-dot alarm-flow-dot--end"><CheckLg aria-hidden /></span>
    <div className="alarm-flow-when">{t('flow_end')}</div>
    <div className="alarm-flow-muted">
      {flow.end.kind === 'acknowledge'
        ? t('flow_end_acknowledge')
        : t('flow_end_back_online', { hours: flow.end.stable_hours ?? 0 })}
    </div>
    <div className="alarm-flow-muted">{t('flow_end_after_last', { stage: flow.stages })}</div>
  </div>
);

/**
 * One open case as a horizontal timeline (equal steps, not to scale): the
 * detection, every stage sent - with its recipients and their mail status -
 * a "jetzt" marker, the stages to come with time and countdown, and how the
 * case ends. On phones it folds to a vertical list (AlarmFlow.css).
 */
const AlarmFlowTimeline = ({ flow, now }: { flow: FlowCase; now: number }) => {
  const { t } = useTranslation();
  const split = nowIndex(flow.points);
  const past = flow.points.slice(0, split);
  const future = flow.points.slice(split);
  // Equal steps: one column per point, a narrower one for "jetzt", one for the end.
  const columns = [...past.map(() => 'minmax(150px, 1fr)'), 'minmax(110px, 0.6fr)',
    ...future.map(() => 'minmax(150px, 1fr)'), 'minmax(130px, 0.8fr)'].join(' ');
  const label = flow.project_id != null ? `#${flow.project_id} ${flow.location_name}` : flow.location_name;
  return (
    <section className="alarm-flow-case" {...repeatedTestId('alarm-flow-case', flow.id)}>
      <header className="alarm-flow-head">
        <Badge bg={flow.kind === 'alarm' ? 'danger' : 'secondary'}>{t(`flow_kind_${flow.kind}`)}</Badge>
        {flow.location_missing ? (
          <span className="alarm-flow-title">{label}</span>
        ) : (
          <Link className="alarm-flow-title" to={statusViewPath(flow.location_id, null)}>{label}</Link>
        )}
        <span className="alarm-flow-muted">
          {flow.stage > 0 ? t('flow_stage_of', { stage: flow.stage, stages: flow.stages }) : t('flow_detected_only')}
        </span>
        <span className="alarm-flow-spacer" />
        <span className="alarm-flow-next" {...repeatedTestId('alarm-flow-next', flow.id)}>
          {flow.next_at
            ? t('flow_next', { when: whenText(flow.next_at, now, t) })
            : t('flow_next_none')}
        </span>
        <Link to={`/staff/?case=${flow.id}`} {...repeatedTestId('alarm-flow-staff-link', flow.id)}>
          {t('flow_open_staff')}
        </Link>
      </header>
      <div className="alarm-flow-scroll">
        <div className="alarm-flow-rail" style={{ gridTemplateColumns: columns }}>
          {past.map((point, index) => (
            <Point key={`p${index}`} flow={flow} point={point} index={index} now={now} t={t} />
          ))}
          <NowMarker flow={flow} now={now} t={t} />
          {future.map((point, index) => (
            <Point key={`f${index}`} flow={flow} point={point} index={split + index} now={now} t={t} />
          ))}
          <EndPoint flow={flow} t={t} />
        </div>
      </div>
    </section>
  );
};

export default AlarmFlowTimeline;
