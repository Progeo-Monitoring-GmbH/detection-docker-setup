import os
import smtplib

from email import encoders
from pathlib import Path
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email.mime.text import MIMEText
from email.utils import formatdate

from progeo.v1.helper import calc_hash_from_dict
from progeo.helper.basics import dlog, elog


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


def send_mail(sent_to: list, subject: str, message: str, files: list):
    sender = os.getenv("MAIL_SENDER")
    reply_to = os.getenv("MAIL_REPLY_TO")
    server = os.getenv("MAIL_SERVER")
    port = int(os.getenv("MAIL_PORT", 587))
    username = os.getenv("MAIL_USER")
    password = os.getenv("MAIL_PW")

    # dlog(sender, sent_to, reply_to, server, port, username)
    try:
        if len(sent_to):
            _send_mail(sender, sent_to, reply_to, subject, message, files, server, port, username, password,
                       use_tls=True)
            # TODO link with email model?
            content = {"sent_to": sent_to, "subject": subject, "message": message, "files": files}
            _hash = calc_hash_from_dict(content)
            dlog(f"Mail was sent to '{sent_to}', hash={_hash}")
            return _hash
    except OSError as e:
        elog("Could not send Mail")
        elog(e)


def send_info_mail(subject: str, message: str):
    target = os.getenv("DJANGO_SUPERUSER_EMAIL")
    if target:
        send_mail([target], subject, message, [])
    else:
        elog(f"'MAIL_INFO' is not set! | value={target}")
