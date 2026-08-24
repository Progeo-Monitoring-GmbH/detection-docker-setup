import os
import re
import smtplib

from email import encoders
from pathlib import Path
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email.mime.text import MIMEText
from email.utils import formatdate

from django.template.loader import render_to_string

from progeo.v1.helper import calc_hash_from_dict
from progeo.helper.basics import dlog, elog, ilog

# ############################################################################################
# Email templates
#
# Templates live in progeo/templates/emails/*.txt and use simple `{placeholder}`
# tokens (e.g. `{project_name}`) that are substituted with the context dict
# passed to render_email_template. The first line of a template is the subject,
# prefixed with "Subject: "; the rest is the body. Unknown placeholders are left
# untouched so missing context values are visible instead of silently dropping.
# ############################################################################################

_PLACEHOLDER_RE = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}")

# Where email templates live (same directory Django discovers via APP_DIRS).
EMAIL_TEMPLATE_DIR = Path(__file__).resolve().parent.parent / "templates" / "emails"


def render_email_template(template_name: str, context: dict | None = None) -> tuple[str, str]:
    """Render `{placeholder}` tokens from `context` and return (subject, body).

    The template's first line must be `Subject: ...`; everything after the
    first blank line is the body. Returns empty strings when the template is
    missing so callers can decide to skip gracefully.
    """
    context = context or {}
    try:
        raw = render_to_string(f"emails/{template_name}", context)
    except Exception as exc:
        elog(f"[emailhelper] Email template not found: emails/{template_name} ({exc})")
        return "", ""

    if not raw:
        elog(f"[emailhelper] Email template not found: emails/{template_name}")
        return "", ""

    def _replace(match):
        key = match.group(1)
        value = context.get(key, match.group(0))
        if value is None:
            value = ""
        return str(value)

    rendered = _PLACEHOLDER_RE.sub(_replace, raw)

    lines = rendered.splitlines()
    subject = ""
    body_lines = []
    subject_seen = False
    for line in lines:
        if not subject_seen and line.lower().startswith("subject:"):
            subject = line.split(":", 1)[1].strip()
            subject_seen = True
            continue
        body_lines.append(line)
    body = "\n".join(body_lines).strip("\n")

    return subject, body


# ############################################################################################
# SMTP settings (template): set these environment variables to activate mail.
# Without MAIL_SERVER / MAIL_SENDER the send functions log and skip.
# ############################################################################################


def smtp_configured() -> bool:
    return bool(os.getenv("MAIL_SERVER") and os.getenv("MAIL_SENDER"))


def _send_mail(send_from, send_to, reply_to, subject, message, files,
               server="localhost", port=587, username='', password='',
               use_tls=True):
    """Compose and send email with provided info and attachments.

    Args:
        send_from (str): from name
        send_to (list[str]): to name(s)
        reply_to (str): reply to
        subject (str): message title
        message (str): message body
        files (list[str]): list of file paths to be attached to email
        server (str): mail server host name
        port (int): port number
        username (str): server auth username
        password (str): server auth password
        use_tls (bool): use TLS mode

    """

    msg = MIMEMultipart()
    msg["From"] = send_from
    msg["To"] = ",".join(send_to)
    msg["Date"] = formatdate(localtime=True)
    msg["Subject"] = subject
    msg.add_header("reply-to", reply_to)

    msg.attach(MIMEText(message))

    for _path in files:
        part = MIMEBase("application", "octet-stream")
        with open(_path, "rb") as file:
            part.set_payload(file.read())
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", "attachment; filename={}".format(Path(_path).name))
        msg.attach(part)

    smtp = smtplib.SMTP(server, port)
    if use_tls:
        smtp.starttls()
    smtp.login(username, password)
    smtp.sendmail(send_from, send_to, msg.as_string())
    smtp.quit()


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


def send_mail(sent_to: list, subject: str, message: str, files: list,
              location=None, db: str = "default"):
    """Send a plain (already rendered) email and record it as an EMail row.

    Returns the content hash when sent, None when sending failed / skipped.
    The mail attempt is always persisted (with `sent`/`error` reflecting the
    outcome) so the EMail model doubles as a mail log. `location` links the
    row to a project when relevant (e.g. disconnect notifications).
    """
    sender = os.getenv("MAIL_SENDER")
    reply_to = os.getenv("MAIL_REPLY_TO")
    server = os.getenv("MAIL_SERVER")
    port = int(os.getenv("MAIL_PORT", 587))
    username = os.getenv("MAIL_USER")
    password = os.getenv("MAIL_PW")

    if not sender or not server:
        ilog(f"[emailhelper] SMTP not configured (MAIL_SENDER/MAIL_SERVER), skipping mail to {sent_to}")
        _persist_email(sent_to, subject, message, files, location=location,
                       sent=False, error="SMTP not configured", db=db)
        return None

    try:
        if len(sent_to):
            _send_mail(sender, sent_to, reply_to, subject, message, files, server, port, username, password,
                       use_tls=True)
            content = {"sent_to": sent_to, "subject": subject, "message": message, "files": files}
            _hash = calc_hash_from_dict(content)
            _persist_email(sent_to, subject, message, files, location=location, sent=True, db=db)
            dlog(f"Mail was sent to '{sent_to}', hash={_hash}")
            return _hash
    except OSError as exc:
        elog("Could not send Mail")
        elog(exc)
        _persist_email(sent_to, subject, message, files, location=location,
                       sent=False, error=str(exc), db=db)
    return None


def send_template_mail(sent_to: list, template_name: str, context: dict | None = None,
                       files: list | None = None, subject_override: str | None = None,
                       location=None, db: str = "default"):
    """Render `template_name` with `context` and send it.

    Returns the content hash when sent, False when the template is missing,
    and None when SMTP is not configured / sending failed. The mail attempt is
    persisted as an EMail row (linked to `location` when given).
    """
    subject, body = render_email_template(template_name, context)
    if not subject and not body:
        return False
    if subject_override:
        subject = subject_override
    return send_mail(sent_to, subject, body, files or [], location=location, db=db)


def send_info_mail(subject: str, message: str):
    target = os.getenv("DJANGO_SUPERUSER_EMAIL")
    if target:
        send_mail([target], subject, message, [])
    else:
        elog(f"'DJANGO_SUPERUSER_EMAIL' is not set! | value={target}")


def send_alarm_email(device_hash, threshold, max_value, exceeding_values, sent_to=None):
    """Template-based alarm notification (see emails/alarm.txt)."""
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
    return send_template_mail(sent_to, "alarm.txt", context)
