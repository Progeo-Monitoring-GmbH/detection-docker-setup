"""clear_logs: remove Django admin log entries and restart their sequence."""
import pytest
from django.contrib.admin.models import LogEntry
from django.core.management import call_command

from progeo.tests import factories as f

pytestmark = pytest.mark.django_db(databases=["default"])


def _log_entry(user):
    return LogEntry.objects.using("default").create(
        user_id=user.pk,
        action_flag=1,
        object_repr="test object",
        change_message="",
    )


def test_clear_logs_deletes_all_entries_and_resets_the_sequence():
    user = f.make_user()
    _log_entry(user)
    _log_entry(user)

    call_command("clear_logs", database="default")

    assert LogEntry.objects.using("default").count() == 0
    # The next admin entry starts at 1 again, not at the old max + 1.
    assert _log_entry(user).pk == 1


def test_clear_logs_dry_run_keeps_the_entries():
    user = f.make_user()
    _log_entry(user)

    call_command("clear_logs", database="default", dry_run=True)

    assert LogEntry.objects.using("default").count() == 1


def test_db_maintenance_reports_the_default_database(capsys):
    call_command("db_maintenance", database="default", limit=5)

    output = capsys.readouterr().out
    assert "Database:" in output
    assert "total" in output
    assert "live" in output
