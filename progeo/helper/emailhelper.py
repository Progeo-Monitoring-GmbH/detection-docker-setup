import html as html_lib
import os
import re
import smtplib
import uuid
from email import encoders
from email.mime.base import MIMEBase
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formatdate, parseaddr
from pathlib import Path

from django.conf import settings
from django.template.loader import render_to_string

from progeo.helper import outbound
from progeo.helper.basics import dlog, elog, ilog
from progeo.helper.interface_config import get_smtp_config
from progeo.v1.helper import calc_hash_from_dict

# ############################################################################################
# Email templates
#
# Every mail is one Django template in progeo/templates/emails/<name>.html
# that extends emails/base.html (the portal's corporate layout). The subject
# is the template's {% block subject %}, the plain-text part is derived from
# its content block - so each mail is written once. Template variables are
# autoescaped in the HTML part.
#
# Secret values (one-time login links) go into `secret_context`: they are in
# the mail that is sent, but the logged copy (EMail.message) shows
# REDACTED_LINK instead, so a database dump holds no working login links.
# ############################################################################################

# Where email templates live (same directory Django discovers via DIRS).
EMAIL_TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates" / "emails"
LOGO_PATH = EMAIL_TEMPLATE_DIR / "assets" / "progeo-logo.png"
LOGO_CID = "progeo-logo"
REDACTED_LINK = "[Einmal-Link - aus Sicherheitsgründen nicht gespeichert]"
# Seconds an SMTP connection/command may take before the send counts as failed.
SMTP_TIMEOUT = 30

# Mirrors frontend/src/main/company.ts (login page footer).
COMPANY = {
    "name": "ProGeo Monitoring Systeme und Services GmbH & Co. KG",
    "street": "Hauptstraße 2",
    "postal_city": "DE-14979 Großbeeren",
    "phone": "+49 33701 22-0",
    "email": "kontakt@progeo.com",
}

_TITLE_RE = re.compile(r"<title>(.*?)</title>", re.DOTALL | re.IGNORECASE)
_TEXT_RE = re.compile(r"<!--progeo-text-start-->(.*?)<!--progeo-text-end-->", re.DOTALL)
_FOOTER_RE = re.compile(r"<!--progeo-footer-start-->(.*?)<!--progeo-footer-end-->", re.DOTALL)
_HTML_ONLY_RE = re.compile(r"<!--progeo-html-only-->.*?<!--/progeo-html-only-->", re.DOTALL)
_LINK_RE = re.compile(r"<a\s[^>]*href=\"([^\"]*)\"[^>]*>(.*?)</a>", re.DOTALL | re.IGNORECASE)


def template_names() -> list[str]:
    """Names of the sendable templates (without base layout and partials)."""
    return sorted(
        path.stem for path in EMAIL_TEMPLATE_DIR.glob("*.html")
        if path.stem != "base" and not path.stem.startswith("_")
    )


def _template_base(template_name: str) -> str:
    """'test_leakage.txt' / 'test_leakage.html' / 'test_leakage' -> 'test_leakage'."""
    name = str(template_name)
    for extension in (".txt", ".html"):
        if name.endswith(extension):
            return name[: -len(extension)]
    return name


def portal_url(path: str = "") -> str:
    """Absolute frontend URL for links in mails. FRONTEND_URL may carry the
    compose-style "@PROTOCOL://" prefix (django.env.template)."""
    protocol = os.getenv("PROTOCOL", "https")
    base = (os.getenv("FRONTEND_URL") or "").strip().replace("@PROTOCOL", protocol)
    if base and "://" not in base:
        base = f"{protocol}://{base}"
    if not base:
        elog("FRONTEND_URL is not set - links in mails point nowhere", tag="[emailhelper]")
    return f"{base.rstrip('/')}/{path.lstrip('/')}" if path else base.rstrip("/")


def html_to_text(markup: str) -> str:
    """Plain-text version of a mail's HTML content (links as 'label: url')."""
    text = _HTML_ONLY_RE.sub("", markup)

    def _link(match):
        url, label = match.group(1), re.sub(r"<[^>]+>", "", match.group(2)).strip()
        if not label or label == url or url.startswith("mailto:"):
            return label or url
        return f"{label}: {url}"

    # Line breaks in the HTML source are just whitespace - only tags break lines.
    text = re.sub(r"\s*\n\s*", " ", text)
    text = _LINK_RE.sub(_link, text)
    text = re.sub(r"</td>\s*<td[^>]*>", ": ", text, flags=re.IGNORECASE)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<li[^>]*>", "\n- ", text, flags=re.IGNORECASE)
    text = re.sub(r"</(p|h\d|ul|table|div)>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</tr>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</td>", "  ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html_lib.unescape(text)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def render_mail(template_name: str, context: dict | None = None, secret_context: dict | None = None) -> dict | None:
    """Render `template_name` -> {"subject", "text", "html", "log_text"}, or
    None when the template is missing. `log_text` is the text with every
    secret_context value redacted."""
    base = _template_base(template_name)
    context = {"company": COMPANY, "portal_url": portal_url(), **(context or {})}
    secrets = secret_context or {}
    try:
        markup = render_to_string(f"emails/{base}.html", {**context, **secrets})
        log_markup = (
            render_to_string(f"emails/{base}.html", {**context, **{key: REDACTED_LINK for key in secrets}})
            if secrets else markup
        )
    except Exception as exc:  # noqa: BLE001 - a broken template must not crash the caller
        elog(f"[emailhelper] Email template not usable: emails/{base}.html ({exc})")
        return None

    def _parts(source):
        title = _TITLE_RE.search(source)
        subject = " ".join(html_lib.unescape(title.group(1)).split()) if title else ""
        content = _TEXT_RE.search(source)
        footer = _FOOTER_RE.search(source)
        text = html_to_text(content.group(1)) if content else html_to_text(source)
        if footer:
            text = f"{text}\n\n-- \n{html_to_text(footer.group(1))}"
        return subject, text

    subject, text = _parts(markup)
    _subject, log_text = _parts(log_markup)
    return {"subject": subject, "text": text, "html": markup, "log_text": log_text}


def render_email_template(template_name: str, context: dict | None = None) -> tuple[str, str]:
    """(subject, plain text) of a template - empty strings when it is missing."""
    rendered = render_mail(template_name, context)
    if not rendered:
        return "", ""
    return rendered["subject"], rendered["text"]


# ############################################################################################
# SMTP settings (template): set these environment variables to activate mail.
# Without MAIL_SERVER / MAIL_SENDER the send functions log and skip.
# ############################################################################################


def smtp_configured() -> bool:
    if not settings.PROGEO_CONFIG_ENABLE_MAILING:
        return False
    cfg = get_smtp_config()
    return bool(cfg.get("server") and cfg.get("sender"))


def test_smtp_connection(cfg: dict | None = None) -> dict:
    """Non-destructive SMTP check: connect, STARTTLS and (when a username is
    configured) authenticate against the server. No mail is sent and nothing
    is persisted. ``cfg`` may override the stored/env config (e.g. unsaved
    form values); when omitted the effective config is used.

    Returns ``{"ok": bool, "steps": [...], "error": str | None}`` so the UI
    can show a step-by-step result.
    """
    cfg = cfg or get_smtp_config()
    server = cfg.get("server")
    if not server:
        return {
            "ok": False,
            "steps": [],
            "error": "No SMTP server configured (server is empty).",
        }
    try:
        port = int(cfg.get("port") or 587)
    except (TypeError, ValueError):
        port = 587
    username = cfg.get("username")
    password = cfg.get("password")

    steps: list[str] = []
    smtp = None
    try:
        smtp = smtplib.SMTP(server, port, timeout=10)
        smtp.ehlo()
        steps.append(f"Connected to {server}:{port}")

        smtp.starttls()
        smtp.ehlo()
        steps.append("TLS handshake OK")

        if username:
            smtp.login(username, password)
            steps.append(f"Login as '{username}' OK")
        else:
            steps.append("No login (no username configured)")

        smtp.quit()
        smtp = None
        return {"ok": True, "steps": steps, "error": None}
    except Exception as exc:
        elog(f"[emailhelper] SMTP connection test failed for {server}:{port}: {exc}")
        return {
            "ok": False,
            "steps": steps,
            "error": f"{type(exc).__name__}: {exc}",
        }
    finally:
        if smtp is not None:
            try:
                smtp.close()
            except Exception:
                pass


def envelope_sender(cfg: dict) -> str:
    """Return-Path of our mails - where bounces arrive (helper/bounces.py)."""
    configured = getattr(settings, "MAIL_ENVELOPE_FROM", "")
    if configured:
        return configured
    username = str(cfg.get("username") or "")
    if "@" in username:
        return username
    return parseaddr(str(cfg.get("sender") or ""))[1]


def new_message_id(sender: str) -> str:
    """<progeo.<32 hex>@domain> - unique, and recognizable in bounces."""
    domain = parseaddr(sender)[1].rpartition("@")[2] or "progeo.com"
    return f"<progeo.{uuid.uuid4().hex}@{domain}>"


def _build_message(send_from, send_to, reply_to, subject, message, files, html=None, message_id=None,
                   headers=None):
    msg = MIMEMultipart("mixed")
    msg["From"] = send_from
    msg["To"] = ",".join(send_to)
    msg["Date"] = formatdate(localtime=True)
    msg["Subject"] = subject
    if message_id:
        msg["Message-ID"] = message_id
    if reply_to:
        msg.add_header("reply-to", reply_to)
    # Machine-generated: no out-of-office replies back into the bounce box.
    msg["Auto-Submitted"] = "auto-generated"
    msg["X-Auto-Response-Suppress"] = "All"
    for name, value in (headers or {}).items():
        msg[name] = value

    if html:
        alternative = MIMEMultipart("alternative")
        alternative.attach(MIMEText(message, "plain", "utf-8"))
        related = MIMEMultipart("related")
        related.attach(MIMEText(html, "html", "utf-8"))
        if f"cid:{LOGO_CID}" in html and LOGO_PATH.exists():
            logo = MIMEImage(LOGO_PATH.read_bytes(), "png")
            logo.add_header("Content-ID", f"<{LOGO_CID}>")
            logo.add_header("Content-Disposition", "inline", filename="progeo-logo.png")
            related.attach(logo)
        alternative.attach(related)
        msg.attach(alternative)
    else:
        msg.attach(MIMEText(message, "plain", "utf-8"))

    for _path in files:
        part = MIMEBase("application", "octet-stream")
        with open(_path, "rb") as file:
            part.set_payload(file.read())
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", f"attachment; filename={Path(_path).name}")
        msg.attach(part)
    return msg


def _send_mail(send_from, send_to, reply_to, subject, message, files,
               server="localhost", port=587, username='', password='',
               use_tls=True, html=None, message_id=None, envelope_from=None, headers=None):
    """Compose and send email with provided info and attachments.

    Args:
        send_from (str): from name
        send_to (list[str]): to name(s)
        reply_to (str): reply to
        subject (str): message title
        message (str): message body (plain text)
        files (list[str]): list of file paths to be attached to email
        server (str): mail server host name
        port (int): port number
        username (str): server auth username
        password (str): server auth password
        use_tls (bool): use TLS mode
        html (str): optional HTML body (sent as multipart/alternative)
        message_id (str): Message-ID header (bounce matching)
        envelope_from (str): Return-Path; defaults to the From address

    Returns the recipients the server refused (empty dict = all accepted).
    """
    msg = _build_message(send_from, send_to, reply_to, subject, message, files, html=html,
                         message_id=message_id, headers=headers)

    smtp = smtplib.SMTP(server, port, timeout=SMTP_TIMEOUT)
    if use_tls:
        smtp.starttls()
    smtp.login(username, password)
    refused = smtp.sendmail(envelope_from or send_from, send_to, msg.as_string())
    smtp.quit()
    return refused or {}


def _persist_email(sent_to: list, subject: str, message: str, files: list,
                   location=None, sent: bool = False, error: str | None = None,
                   db: str = "default"):
    """Store the mail attempt as an EMail row (linked to a location when given)."""
    from progeo.v1.creator import create_email_safe

    create_email_safe(
        sent_to=", ".join(sent_to) if sent_to else "",
        subject=subject,
        message=message,
        files=", ".join(files or []),
        location=location,
        sent=sent,
        error=error,
        db=db,
    )


def _is_hard_refusal(exc_or_code) -> bool:
    code = exc_or_code[0] if isinstance(exc_or_code, tuple) else exc_or_code
    try:
        return 500 <= int(code) < 600
    except (TypeError, ValueError):
        return False


def send_mail(sent_to: list, subject: str, message: str, files: list,
              location=None, db: str = "default", html: str | None = None,
              category: str = "system", log_message: str | None = None):
    """Send an (already rendered) email and record it.

    Every mail passes the outbound guard (helper/outbound.py) first: too many
    recipients, a tripped circuit breaker, suppressed (bounced) addresses and
    per-recipient/global limits drop recipients; in MAIL_TEST_MODE the mail
    goes to MAIL_TEST_RECIPIENT with the original recipients in the subject.

    Returns the content hash when sent, None when sending failed / skipped.
    The mail attempt is persisted as an EMail row (with `sent`/`error`
    reflecting the outcome; `log_message` replaces the body there, e.g. with
    redacted login links) and as one OutboundMessage row per recipient.
    `location` links the rows to a project.
    """
    from progeo.v1.models import OutboundMessage

    status = OutboundMessage.Status
    mail = OutboundMessage.Channel.MAIL
    cfg = get_smtp_config()
    sender = cfg.get("sender")
    reply_to = cfg.get("reply_to")
    server = cfg.get("server")
    try:
        port = int(cfg.get("port") or 587)
    except (TypeError, ValueError):
        port = 587
    username = cfg.get("username")
    password = cfg.get("password")
    logged_body = message if log_message is None else log_message

    if not settings.PROGEO_CONFIG_ENABLE_MAILING:
        ilog(f"[emailhelper] Mailing disabled (PROGEO_CONFIG_ENABLE_MAILING=0), skipping mail to {sent_to}")
        return None

    recipients = list(dict.fromkeys(outbound.normalize_address(r) for r in sent_to or [] if r))
    if not recipients:
        return None

    max_recipients = outbound.limits()["mail_max_recipients"]
    if len(recipients) > max_recipients:
        error = f"Zu viele Empfänger ({len(recipients)} > {max_recipients}) - Mail nicht versendet"
        elog(f"[emailhelper] {error}: {subject}")
        for recipient in recipients:
            outbound.log(mail, status.BLOCKED, recipient, category=category, subject=subject,
                         location=location, error=error)
        _persist_email(recipients, subject, logged_body, files, location=location, sent=False, error=error, db=db)
        return None

    allowed, rejected = outbound.check(mail, recipients)
    for recipient, (reject_status, error) in rejected.items():
        ilog(f"[emailhelper] Not sending '{subject}' to {recipient}: {error}")
        outbound.log(mail, reject_status, recipient, category=category, subject=subject,
                     location=location, error=error)
    if not allowed:
        error = "; ".join(sorted({error for _status, error in rejected.values()}))
        _persist_email(recipients, subject, logged_body, files, location=location, sent=False, error=error, db=db)
        return None

    if not sender or not server:
        ilog(f"[emailhelper] SMTP not configured (MAIL_SENDER/MAIL_SERVER), skipping mail to {allowed}")
        for recipient in allowed:
            outbound.log(mail, status.FAILED, recipient, category=category, subject=subject,
                         location=location, error="SMTP not configured")
        _persist_email(allowed, subject, logged_body, files, location=location,
                       sent=False, error="SMTP not configured", db=db)
        return None

    headers = {"X-Progeo-Category": category}
    deliver_to, sent_status, sent_subject = allowed, status.SENT, subject
    if outbound.mail_test_mode():
        deliver_to = [outbound.mail_test_recipient()]
        sent_status = status.REDIRECTED
        sent_subject = f"[TEST an {', '.join(allowed)}] {subject}"
        headers["X-Original-To"] = ", ".join(allowed)

    message_id = new_message_id(sender)
    try:
        refused = _send_mail(sender, deliver_to, reply_to, sent_subject, message, files, server, port,
                             username, password, use_tls=True, html=html, message_id=message_id,
                             envelope_from=envelope_sender(cfg), headers=headers)
    except smtplib.SMTPRecipientsRefused as exc:
        refused = exc.recipients
    except OSError as exc:
        elog(f"Could not send Mail to '{deliver_to}': {exc}")
        for recipient in allowed:
            outbound.log(mail, status.FAILED, recipient, actual_recipient=", ".join(deliver_to), category=category,
                         subject=subject, message_id=message_id, location=location, error=str(exc))
        _persist_email(allowed, sent_subject, logged_body, files, location=location,
                       sent=False, error=str(exc), db=db)
        return None

    refused = {outbound.normalize_address(address): reason for address, reason in (refused or {}).items()}
    accepted = []
    for recipient, actual in ((r, deliver_to[0] if outbound.mail_test_mode() else r) for r in allowed):
        reason = refused.get(actual)
        if reason is not None:
            error = f"Vom Server abgelehnt: {reason}"
            outbound.log(mail, status.FAILED, recipient, actual_recipient=actual, category=category,
                         subject=subject, message_id=message_id, location=location, error=error)
            if _is_hard_refusal(reason) and not outbound.mail_test_mode():
                from progeo.helper.bounces import record_bounce

                record_bounce(recipient, hard=True, reason=error)
            continue
        accepted.append(recipient)
        outbound.log(mail, sent_status, recipient, actual_recipient=actual, category=category,
                     subject=subject, message_id=message_id, location=location)

    if not accepted:
        _persist_email(allowed, sent_subject, logged_body, files, location=location,
                       sent=False, error="Alle Empfänger vom Server abgelehnt", db=db)
        return None

    content = {"sent_to": accepted, "subject": sent_subject, "message": message, "files": files}
    _hash = calc_hash_from_dict(content)
    _persist_email(accepted, sent_subject, logged_body, files, location=location, sent=True, db=db)
    dlog(f"Mail was sent to '{deliver_to}' (for {accepted}), hash={_hash}")
    return _hash


def send_template_mail(sent_to: list, template_name: str, context: dict | None = None,
                       files: list | None = None, subject_override: str | None = None,
                       location=None, db: str = "default", category: str = "system",
                       secret_context: dict | None = None):
    """Render `template_name` with `context` and send it (HTML + text).

    Returns the content hash when sent, False when the template is missing,
    and None when SMTP is not configured / sending failed or was blocked. The
    mail attempt is persisted as an EMail row (linked to `location` when
    given) - with every `secret_context` value redacted.
    """
    rendered = render_mail(template_name, context, secret_context)
    if not rendered or (not rendered["subject"] and not rendered["text"]):
        return False
    subject = subject_override or rendered["subject"]
    return send_mail(sent_to, subject, rendered["text"], files or [], location=location, db=db,
                     html=rendered["html"], category=category,
                     log_message=rendered["log_text"] if secret_context else None)


def send_info_mail(subject: str, message: str):
    target = os.getenv("DJANGO_SUPERUSER_EMAIL")
    if target:
        send_mail([target], subject, message, [])
    else:
        elog(f"'DJANGO_SUPERUSER_EMAIL' is not set! | value={target}")


def send_breaker_alert(reason: str):
    """Tell the admin the circuit breaker tripped. Bypasses outbound.check()
    (the breaker blocks everything else) but not the test mode."""
    target = os.getenv("DJANGO_SUPERUSER_EMAIL")
    cfg = get_smtp_config()
    if not target or not settings.PROGEO_CONFIG_ENABLE_MAILING or not cfg.get("server") or not cfg.get("sender"):
        elog(f"[emailhelper] Breaker alert not mailed (no DJANGO_SUPERUSER_EMAIL / SMTP): {reason}")
        return None
    rendered = render_mail("breaker_alert", {"reason": reason, "staff_url": portal_url("/staff/")})
    if not rendered:
        return None
    deliver_to = [outbound.mail_test_recipient()] if outbound.mail_test_mode() else [target]
    try:
        port = int(cfg.get("port") or 587)
    except (TypeError, ValueError):
        port = 587
    try:
        _send_mail(cfg["sender"], deliver_to, cfg.get("reply_to"), rendered["subject"], rendered["text"], [],
                   cfg["server"], port, cfg.get("username"), cfg.get("password"), html=rendered["html"],
                   message_id=new_message_id(cfg["sender"]), envelope_from=envelope_sender(cfg),
                   headers={"X-Progeo-Category": "breaker_alert"})
    except OSError as exc:
        elog(f"[emailhelper] Breaker alert could not be sent: {exc}")
        return None
    return True


def send_alarm_email(device_hash, threshold, max_value, exceeding_values, sent_to=None):
    """Template-based alarm notification (see emails/alarm.html)."""
    sent_to = sent_to or [os.getenv("DJANGO_SUPERUSER_EMAIL")]
    sent_to = [target for target in sent_to if target]
    if not sent_to:
        return None

    context = {
        "device_hash": device_hash,
        "threshold": threshold,
        "max_value": max_value,
        "exceeding_values": ", ".join(str(value) for value in exceeding_values),
    }
    return send_template_mail(sent_to, "alarm", context, category="alarm")
