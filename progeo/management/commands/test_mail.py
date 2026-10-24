import os
import socket
from datetime import datetime

from django.conf import settings
from django.core.management.base import CommandError

from progeo.helper import emailhelper, interface_config
from progeo.management.commands._base import BaseCommand

DEFAULT_RECIPIENT = "test-mails@progeo.com"
SUBJECT_PREFIX = "[TEST] "

# Sample values for the shipped templates (progeo/templates/emails/*.html).
# Variables without a sample render empty, like in production.
SAMPLE_CONTEXT = {
    "device_hash": "a1b2c3d4e5",
    "threshold": 100,
    "max_value": 250,
    "exceeding_values": "150, 210, 250",
    "project_name": "Testobjekt Musterstraße",
    "project_nr": "4711",
    "case_id": "4711-20261020",
    "last_measurement_at": "20.10.2026 08:15",
    "range_from": "01.10.2026",
    "range_to": "20.10.2026",
    "triggered_by": "manage.py test_mail",
    "triggered_at": "20.10.2026 08:15",
    "sensors": "S3 (250), S4 (180)",
    "cooldown_minutes": 60,
    "first_name": "Erika",
    "username": "erika.mustermann",
    "valid_minutes": 15,
    "valid_hours": 72,
    "reason": "Globales MAIL-Limit (100 pro Stunde) erreicht",
    "request": {"first_name": "Erika", "last_name": "Mustermann", "company": "Musterbau GmbH",
                "email": "erika@progeo.com", "phone": "+49 30 123456", "project": "Objekt 4711",
                "message": "Bitte um Zugang zum Objekt 4711."},
}
# Link variables get a harmless sample URL (never a real one-time link).
SAMPLE_LINK_KEYS = ("action_url", "portal_link", "login_url", "review_url", "staff_url")


def _template_names():
    return emailhelper.template_names()


def _sample_context(template_name):
    context = {"timestamp": datetime.now().strftime("%d.%m.%Y %H:%M"), **SAMPLE_CONTEXT}
    for key in SAMPLE_LINK_KEYS:
        context[key] = emailhelper.portal_url("/login")
    return context


class Command(BaseCommand):
    help = (
        'Check the SMTP setup and send test mails (default recipient: '
        f'{DEFAULT_RECIPIENT}).\n\n'
        'Prints the effective SMTP config (stored "Schnittstelle" config wins over\n'
        'the MAIL_* env vars), tests connect / TLS / login and then sends a plain\n'
        'test mail. With --templates every email template is rendered with sample\n'
        'data and sent as well. Subjects are prefixed with "[TEST] ". Every sent\n'
        'mail is logged as an EMail row like any other mail.\n\n'
        'Examples:\n'
        '  python manage.py test_mail\n'
        '  python manage.py test_mail --templates\n'
        '  python manage.py test_mail --template disconnect_project.txt\n'
        '  python manage.py test_mail --templates --dry-run\n'
        '  python manage.py test_mail --to test-mails@progeo.com kontakt@progeo.com'
    )

    def add_arguments(self, parser):
        parser.add_argument("--to", nargs="+", default=[DEFAULT_RECIPIENT],
                            help=f"Recipient address(es), default {DEFAULT_RECIPIENT}.")
        parser.add_argument("--templates", action="store_true",
                            help="Also send every template in progeo/templates/emails.")
        parser.add_argument("--template", action="append", choices=_template_names(),
                            help="Send only this template (repeatable). Skips the plain test mail.")
        parser.add_argument("--dry-run", action="store_true",
                            help="Only print config and rendered mails; no connection, nothing sent.")

    def handle(self, *args, **options):
        recipients = options["to"]
        dry_run = options["dry_run"]

        self._print_config()

        if not dry_run:
            if not settings.PROGEO_CONFIG_ENABLE_MAILING:
                raise CommandError("PROGEO_CONFIG_ENABLE_MAILING is off - send_mail would skip every mail.")
            self._check_connection()

        failures = []
        if not options["template"]:
            subject = f"{SUBJECT_PREFIX}SMTP-Test von {socket.gethostname()}"
            body = (
                "Dies ist eine Testnachricht des Mess-Servers.\n\n"
                f"Host: {socket.gethostname()}\n"
                f"Zeitpunkt: {datetime.now().strftime('%d.%m.%Y %H:%M:%S')}\n"
                f"Absender: {interface_config.get_smtp_config().get('sender')}\n"
            )
            failures += self._send("plain test mail", recipients, subject, body, dry_run)

        templates = options["template"] or (_template_names() if options["templates"] else [])
        for name in templates:
            rendered = emailhelper.render_mail(name, _sample_context(name))
            failures += self._send(name, recipients, SUBJECT_PREFIX + rendered["subject"], rendered["text"], dry_run,
                                   html=rendered["html"])

        if failures:
            raise CommandError(f"Sending failed for: {', '.join(failures)} (see log / EMail rows for the error)")
        if not dry_run:
            self.stdout.write(self.style.SUCCESS(f"Done - check the inbox of {', '.join(recipients)}."))

    def _print_config(self):
        cfg = interface_config.get_smtp_config()
        stored = interface_config._stored("smtp") or {}
        self.stdout.write(f"PROGEO_CONFIG_ENABLE_MAILING = {settings.PROGEO_CONFIG_ENABLE_MAILING}")
        self.stdout.write(f"MAIL_TEST_MODE = {settings.MAIL_TEST_MODE} (-> {settings.MAIL_TEST_RECIPIENT})")
        self.stdout.write("Effective SMTP config:")
        for field, env_name in interface_config._SMTP_ENV.items():
            value = cfg.get(field)
            if field == "password" and value:
                value = "********"
            if stored.get(field) not in (None, ""):
                source = "stored config (UI)"
            elif os.getenv(env_name) is not None:
                source = f"env {env_name}"
            else:
                source = "default"
            self.stdout.write(f"  {field:<9} = {value!s:<40} [{source}]")

    def _check_connection(self):
        result = emailhelper.test_smtp_connection()
        for step in result["steps"]:
            self.stdout.write(f"  ok: {step}")
        if not result["ok"]:
            raise CommandError(f"SMTP connection test failed: {result['error']}")

    def _send(self, label, recipients, subject, body, dry_run, html=None):
        if dry_run:
            self.stdout.write(f"\n--- {label}\nSubject: {subject}\n\n{body}\n")
            return []
        if emailhelper.send_mail(recipients, subject, body, [], html=html, category="test"):
            self.stdout.write(self.style.SUCCESS(f"  sent: {label} ({subject})"))
            return []
        self.stdout.write(self.style.ERROR(f"  FAILED: {label} ({subject})"))
        return [label]
