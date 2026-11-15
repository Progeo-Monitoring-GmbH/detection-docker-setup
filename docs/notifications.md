# Staged notifications (offline / alarm)

When a location stops sending data or raises an alarm, the people subscribed to it are told in stages. They are reminded until the problem is solved or acknowledged, and the case is escalated to staff if nobody reacts. Every location's current phase is visible on the staff page **Staff → Benachrichtigungen**.

Code: [progeo/helper/notification_cases.py](../progeo/helper/notification_cases.py) (engine), [progeo/v1/viewsets/notification_viewset.py](../progeo/v1/viewsets/notification_viewset.py) (API), [frontend/src/main/StaffNotificationCases.tsx](../frontend/src/main/StaffNotificationCases.tsx) (monitoring), [frontend/src/main/NotificationLinkPage.tsx](../frontend/src/main/NotificationLinkPage.tsx) (mail links), tests in [progeo/tests/test_notification_cases.py](../progeo/tests/test_notification_cases.py).

## The model

A **`NotificationCase`** is one problem of one location. It has a kind (`offline` or `alarm`), a stage, the next contact time and a protocol (`NotificationCaseEvent`). There is at most one open case per location and kind. Closed cases are kept as history.

Cases live in the `default` database, like `OutboundMessage`. `case.db` names the database that holds the location's devices, alarms and `ProgeoAccess` rows: the project database once `PROJECT_DB_SPLIT` is on.

| Model | Purpose |
| --- | --- |
| `NotificationCase` | Kind, stage, phase fields, offline devices / alarm ids, who was notified |
| `NotificationCaseEvent` | Append-only protocol (detected, stage sent, bounce, acknowledged, unsubscribed, …) |
| `NotificationToken` | One acknowledge/unsubscribe token per recipient and mail (only the SHA-256 is stored) |
| `NotificationOptOut` | Proof of every unsubscribe; also keeps contact addresses without a subscription off the list |
| `OutboundMessage.case_id` | Connects every sent mail to its case, so bounces reach the case |

## Offline

**Detection: per device, hourly at :50** (`detect_offline_devices`). A device is offline when its last sign of life (newest measurement or command poll) is older than both `2 × data_interval + 10 min` and `NOTIFY_OFFLINE_AFTER_HOURS` (6 h). One case per location collects the offline devices.

These devices never open a case:

- devices that never sent anything (new installations)
- devices that have been silent longer than `NOTIFY_OFFLINE_IGNORE_AFTER_DAYS` (60 days, i.e. dismantled)

Detection sends no mail. Mails go out with `process_notification_cases` (every 15 min).

| Stage | When (`NOTIFY_OFFLINE_STAGE_DAYS` = 0,3,7,14) | Template | To |
| --- | --- | --- | --- |
| 1 | next 09:00 after detection | `disconnect_project` | TIMEOUT subscribers + location contact mail |
| 2 | day 3, 09:00 | `offline_reminder` | same |
| 3 | day 7, 09:00 | `offline_reminder` | same + Objektleitung |
| 4 | day 14, 09:00 | – | `ProgeoEscalation` opened (assigned to the Objektleitung), staff digest; no more customer mails |

**Only resolving the outage ends the case.** Acknowledging via the mail link is recorded (monitoring: "Kenntnisnahme"), but the reminders continue.

### Back online, without mail loops

1. **Stability wait.** When every device of the case sends again, the case waits `NOTIFY_ONLINE_STABLE_HOURS` (2 h). If a device drops again during the wait, the wait starts over.
2. **One "wieder online" mail** (`offline_resolved`). It goes only to the addresses that received an offline mail of this case, only if stage ≥ 1 was sent, and only inside the window.
3. **Reopen instead of restart.** If the location goes offline again within `NOTIFY_REOPEN_HOURS` (48 h), the old case reopens at its stage. There is no new first notice, and the reminders keep the original schedule. A "wieder online" mail that hasn't gone out yet is dropped.
4. **Cooldown.** At most one "wieder online" mail per location per `NOTIFY_ONLINE_MAIL_COOLDOWN_DAYS` (7 days).

So a device that flaps daily causes at most the normal stage mails plus one "wieder online" mail per week.

## Alarm

`notify_alarm` (called for every new alarm, as before) opens the location's alarm case and sends stage 1 **immediately, at any hour**. Alarms older than `ALARM_NOTIFY_MAX_AGE_HOURS` (re-evaluated history) notify nobody. While the case is open, further alarms only join it. This replaces the old 60-minute cooldown.

| Stage | When (`NOTIFY_ALARM_STAGE_HOURS` = 0,4,24) | Template | To |
| --- | --- | --- | --- |
| 1 | immediately | `alarm_notification` | ALARM subscribers (mail / SMS / messenger, as they chose) |
| 2 | +4 h, not acknowledged | `alarm_reminder` | same |
| 3 | +24 h, not acknowledged | `alarm_reminder` | same + Objektleitung; `ProgeoEscalation` opened |

Alarm stages ignore the send window, including the reminders. The case closes when:

- someone acknowledges via the mail link, which sets the case's alarms to `quittiert`, or
- all its alarms are acknowledged in the portal, or
- its alarms were deleted.

## Send window and mail budget

- **Offline mails** (stages, "wieder online", staff digest) go out only between `NOTIFY_WINDOW_START_HOUR` and `NOTIFY_WINDOW_END_HOUR` (09–22, Europe/Berlin), weekends included.
- **The 00:37 daily report (`generate_daily_alarm_report`) sends no mails any more.** It only records statistics. The same goes for `manage.py generate_alarm_reports`.
- **Offline mail budget.** Offline mails use at most `NOTIFY_OFFLINE_MAIL_SHARE` (50 %) of `MAIL_LIMIT_GLOBAL_HOUR`. When many locations are due at 09:00, the rest is deferred to the following runs (09:15, 09:30, …). Without this cap, a busy morning would trip the circuit breaker, and that blocks **all** mail, alarms included.
- **Alarms** are not capped by the budget. They still pass the normal outbound limits.

## Links in every mail

Every mail contains, per recipient:

- **an acknowledge link**: `/benachrichtigung/<token>?aktion=quittieren`
- **an unsubscribe link**: `/benachrichtigung/<token>?aktion=abmelden`
- **`List-Unsubscribe` + `List-Unsubscribe-Post` headers** (RFC 8058 one-click), as Gmail and Yahoo expect

How the links behave:

- **The page only acts on a button click.** Mail scanners open every link, so loading the page must never acknowledge an alarm or unsubscribe anybody.
- **Links work without a login.** The token is the key. They stay valid for `NOTIFY_LINK_DAYS` (60).
- **Tokens never land in the mail log.** The `EMail` rows show a redacted placeholder. Tokens are created in the worker and never pass through the broker.

**Unsubscribe** removes the ALARM or TIMEOUT bit from the user's `ProgeoAccess` row. The row itself stays, because it is also the user's portal access. A `NotificationOptOut` row is kept as proof. For the location's contact mail and for the Objektleitung, who have no subscription bit, that opt-out row is what keeps them off the list. When a location loses its last recipient this way, the staff digest says so.

Public endpoints (throttled per IP, no login):

```
POST /api/auth-support/notifications/check/        {token}
POST /api/auth-support/notifications/acknowledge/  {token}
POST /api/auth-support/notifications/unsubscribe/  {token}
POST /api/auth-support/notifications/one-click/<token>/   (mail clients, RFC 8058)
```

## Bounces

Bounces still go through [bounces.py](../progeo/helper/bounces.py): immediate SMTP 5xx refusals, and DSNs read from the bounce mailbox every 10 minutes. Hard bounces, or three soft bounces, suppress the address.

What's new is the link to the case. `OutboundMessage.case_id` lets every bounce add a `bounce` event to its case. If a stage reached nobody, the case is marked **unreachable**. That covers three situations: there was no recipient, every address was suppressed, or every mail bounced.

Unreachable cases show in the monitoring, the staff digest and the Prometheus alert `NotificationCasesUnreachable`. The fix is to correct the contact data, or to remove a wrong suppression under Staff → Versand.

## Language

Every mail goes out in its recipient's language:

- **Storage:** the language is `UserProfile.language`. It is stored when the user changes the language in Mein Konto or with the top bar's switch (`POST /v1/user/language/`).
- **Lookup:** `send_template_mail` resolves it from the recipient address (`emailhelper.recipient_language`) and renders `progeo/templates/emails/<language>/<name>.html`.
- **Fallback:** the German template in `emails/` is used for unknown addresses (such as the location's contact mail), users without a stored language, and templates without a translation (the staff mails).
- **SMS and messenger:** the alarm texts are chosen per recipient the same way (`notification_cases.ALARM_WORDS`).

Preview the English mails with `python manage.py test_mail --templates --language en`. A new template needs both files; `test_english_templates_render_and_fall_back_to_german` renders every template in English.

## Messenger (ProGeo chat) as the primary channel

Mein Konto and the notification tab recommend our own Matrix chat. The setup dialog signs the phone in by QR code, without a password, and switches the messenger channel on for all of the user's subscriptions. Details: [docker/matrix/README.md](../docker/matrix/README.md).

## Monitoring

**Staff → Benachrichtigungen** shows a tile row of open cases per kind and phase, and a list filterable by state and kind. A case's detail view has its devices or alarms, who was notified, the protocol, and the actions *mute 7 days*, *mute until released*, *release* and *close*.

Phases:

| Phase | Meaning |
| --- | --- |
| detected | case open, nothing sent yet |
| notified | stage 1 sent |
| reminder | stage ≥ 2 sent |
| escalated | `ProgeoEscalation` opened |
| recovering | all devices back, stability wait running |
| muted | staff mute or baseline |
| resolved | closed |

Two flags are shown on top of the phase: **unreachable** and **Kenntnisnahme** (receipt confirmed via the mail link).

Also available:

- **Daily staff digest** to `NOTIFY_STAFF_ADDRESS`, at the first run inside the window. It lists escalations, unreachable cases and locations whose last recipient unsubscribed, and is only sent when there is something to report.
- **Prometheus metrics:** `progeo_notification_cases_open{kind,phase}`, `progeo_notification_cases_unreachable{kind}` and `progeo_notification_process_last_run_timestamp_seconds`.
- **Prometheus alerts** `NotificationProcessingStale` (no run for 45 min) and `NotificationCasesUnreachable`.
- **Django admin:** *Notification cases* (with protocol) and *Notification opt outs*.

## Rollout

1. **Apply the migration.** Run `makemigrations --check` and then `migrate` (0057_notification_cases). Deploy backend and frontend.
2. **Let the baseline run.** The **first run** of `detect_offline_devices` is the baseline. Every location that is already offline gets a case that is **muted until released**, so nobody gets mail about old outages. Staff release the cases they want to pursue (Staff → Benachrichtigungen → *Freigeben*). The first offline stage then goes out at the next 09:00.
3. **Check on staging first.** `MAIL_TEST_MODE=1` (the default) redirects all mails to `MAIL_TEST_RECIPIENT`. `CELERY_DISABLED_TASKS=detect_offline_devices,process_notification_cases` switches the system off on a server.
4. **Check deliverability before going live.** SPF, DKIM and DMARC of the sending domain matter now that reminders go out regularly.

## Settings (`django.env`)

| Variable | Default | |
| --- | --- | --- |
| `NOTIFY_WINDOW_START_HOUR` / `_END_HOUR` | 9 / 22 | send window for offline mails (Europe/Berlin) |
| `NOTIFY_OFFLINE_AFTER_HOURS` | 6 | minimum silence before a device counts as offline |
| `NOTIFY_OFFLINE_IGNORE_AFTER_DAYS` | 60 | devices silent longer than this open no case |
| `NOTIFY_OFFLINE_STAGE_DAYS` | 0,3,7,14 | offline stages (last one = escalation) |
| `NOTIFY_ALARM_STAGE_HOURS` | 0,4,24 | alarm stages (last one adds Objektleitung + escalation) |
| `NOTIFY_ONLINE_STABLE_HOURS` | 2 | stability wait before "wieder online" |
| `NOTIFY_REOPEN_HOURS` | 48 | reopen instead of a new first notice |
| `NOTIFY_ONLINE_MAIL_COOLDOWN_DAYS` | 7 | at most one "wieder online" mail per location |
| `NOTIFY_OFFLINE_MAIL_SHARE` | 0.5 | share of the global hourly mail limit for offline mails |
| `NOTIFY_LINK_DAYS` | 60 | validity of acknowledge/unsubscribe links |
| `NOTIFY_STAFF_ADDRESS` | kontakt@progeo.com | daily staff digest |
| `ALARM_NOTIFY_MAX_AGE_HOURS` | 6 | older alarms notify nobody (`ALARM_NOTIFY_COOLDOWN_MINUTES` is gone) |

## Not covered yet

- **SMS and messenger** carry no acknowledge or unsubscribe link. There is no room in an SMS, and the messenger log stores the text in plain. People unsubscribe from those channels in the portal settings.
- **No planned pause per location yet** (construction work, scheduled power cut). For now, staff mute the case once it is opened.
