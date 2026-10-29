"""Export of the new Lageplan files as a tar (helper/lageplan_export.py, the
export_lageplans command and GET /v1/status/admin/lageplan_export/)."""
import io
import os
import tarfile
import time
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from progeo.helper import lageplan_export
from progeo.tests import factories as f

DAY = 86400
NOW = time.time()


@pytest.fixture
def plan_dir(tmp_path, monkeypatch):
    directory = tmp_path / "lageplan"
    directory.mkdir()
    monkeypatch.setattr(lageplan_export, "LAGEPLAN_DIR", str(directory))
    return directory


def _plan(directory, name, age_days):
    path = directory / name
    path.write_bytes(name.encode())
    os.utime(path, (NOW - age_days * DAY, NOW - age_days * DAY))
    return str(path)


def _names(files):
    return sorted(os.path.basename(path) for path, _mtime in files)


def test_recent_lageplans_keeps_the_window(plan_dir):
    _plan(plan_dir, "new.png", 0.5)
    _plan(plan_dir, "two_days.png", 2)
    _plan(plan_dir, "old.png", 10)

    files, days = lageplan_export.recent_lageplans(3, now=NOW)

    assert (_names(files), days) == (["new.png", "two_days.png"], 3)


def test_recent_lageplans_widens_until_one_is_found(plan_dir):
    _plan(plan_dir, "five_days.png", 5)
    _plan(plan_dir, "old.png", 20)

    files, days = lageplan_export.recent_lageplans(1, now=NOW)

    # 1 -> 2 -> 4 -> 8 days: the first window holding a plan.
    assert (_names(files), days) == (["five_days.png"], 8)


def test_recent_lageplans_without_any_file(plan_dir):
    assert lageplan_export.recent_lageplans(7, now=NOW) == ([], 7)


def test_tar_holds_the_files_below_lageplan(plan_dir):
    (plan_dir / "sub").mkdir()
    files = [(_plan(plan_dir, "a.png", 0), NOW), (_plan(plan_dir / "sub", "b.png", 0), NOW)]
    target = io.BytesIO()

    lageplan_export.write_lageplan_tar(files, target)

    with tarfile.open(fileobj=io.BytesIO(target.getvalue())) as tar:
        assert sorted(tar.getnames()) == ["lageplan/a.png", "lageplan/sub/b.png"]
        assert tar.extractfile("lageplan/a.png").read() == b"a.png"


def test_command_writes_the_tar(plan_dir, tmp_path):
    _plan(plan_dir, "new.png", 0.2)
    _plan(plan_dir, "old.png", 30)
    output = tmp_path / "out" / "plans.tar"
    out = StringIO()

    call_command("export_lageplans", "--days", "1", "--output", str(output), stdout=out)

    with tarfile.open(output) as tar:
        assert tar.getnames() == ["lageplan/new.png"]
    assert "1 Lageplan(s) of the last 1 days" in out.getvalue()


def test_command_without_lageplans_fails(plan_dir):
    with pytest.raises(CommandError, match="No Lageplan files found"):
        call_command("export_lageplans", stdout=StringIO())


def test_admin_download(api_client, plan_dir):
    _plan(plan_dir, "new.png", 4)
    api_client.force_authenticate(user=f.make_user(perms=("module_admin_enabled",)))

    response = api_client.get("/v1/status/admin/lageplan_export/?days=3")

    assert response.status_code == 200
    assert (response["X-Lageplan-Days"], response["X-Lageplan-Count"]) == ("6", "1")
    assert "lageplans_" in response["Content-Disposition"]
    with tarfile.open(fileobj=io.BytesIO(b"".join(response.streaming_content))) as tar:
        assert tar.getnames() == ["lageplan/new.png"]


def test_admin_download_needs_admin_and_files(api_client, plan_dir):
    api_client.force_authenticate(user=f.make_user())
    assert api_client.get("/v1/status/admin/lageplan_export/").status_code == 403

    api_client.force_authenticate(user=f.make_user(perms=("module_admin_enabled",)))
    assert api_client.get("/v1/status/admin/lageplan_export/").status_code == 404
    assert api_client.get("/v1/status/admin/lageplan_export/?days=x").status_code == 400
