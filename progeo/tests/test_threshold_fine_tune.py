"""fine_tune_thresholds (helper/threshold_fine_tune.py): the proposal per
location from the true maximum, its file, --apply and --revert."""
import json
import os
from datetime import timedelta

import pytest
from django.core.management import call_command
from django.utils import timezone

from progeo.helper import threshold_fine_tune as ft
from progeo.tests import factories as f
from progeo.v1.models import ProgeoLocation

PROJECT = 880001


@pytest.fixture(autouse=True)
def fine_tune_dir(settings, tmp_path):
    settings.FINE_TUNE_DIR = str(tmp_path / "fine-tune")
    return settings.FINE_TUNE_DIR


@pytest.fixture
def location():
    account = f.make_account()
    return f.make_location(account, project_id=PROJECT, alarm_threshold=100, name="Halle Fein")


def _measure(device, pairs, ago=timedelta(hours=1), **fields):
    return f.make_measurement(device, pairs=pairs, fetched_at=timezone.now() - ago, **fields)


def _entry(findings, location):
    return next(entry for entry in findings["locations"] if entry["location_id"] == location.pk)


def _threshold(location):
    return ProgeoLocation.objects.using(f.DB).get(pk=location.pk).alarm_threshold


# -- the rule ------------------------------------------------------------------

@pytest.mark.parametrize("current, maximum, action, proposed", [
    (100, 60, ft.LOWER, 75),     # 60 * 1.25 = 75 < 100
    (100, 80, ft.KEEP, 100),     # exactly the buffer
    (100, 88, ft.RAISE, 110),    # inside the buffer, +10% < 15%
    (100, 96, ft.REVIEW, 120),   # +20%: left to a person
    (100, 10, ft.LOWER, 30),     # never below the minimum
    (20, 10, ft.REVIEW, 30),     # the minimum itself would raise by 50%
    (100, None, ft.NO_DATA, None),
])
def test_decide(current, maximum, action, proposed):
    decision = ft.decide(current, maximum)
    assert (decision["action"], decision["proposed"]) == (action, proposed)


def test_decide_rounds_the_buffer_up():
    assert ft.decide(100, 61)["proposed"] == 77  # 76.25 -> 77: never less than the buffer


@pytest.mark.parametrize("text, expected", [
    ("15m", timedelta(minutes=15)), ("2h", timedelta(hours=2)), ("1d", timedelta(days=1)),
    ("30", timedelta(minutes=30)), ("0", None), (None, None),
])
def test_parse_step(text, expected):
    assert ft.parse_step(text) == expected


def test_parse_step_rejects_nonsense():
    with pytest.raises(ft.FineTuneError):
        ft.parse_step("1 week")


# -- the scan ------------------------------------------------------------------

def test_scan_takes_the_true_maximum_of_the_window(location):
    device = f.make_device(location)
    _measure(device, [40, 60])
    _measure(device, [500, 500], ago=timedelta(days=40))  # before the window
    _measure(device, [900, 900], archived=True)            # test data

    entry = _entry(ft.scan(projects=[PROJECT], days=30), location)

    assert entry["max_value"] == 60
    assert entry["max_at"]["sensor_order"] == 2
    assert (entry["action"], entry["proposed"], entry["change_percent"]) == (ft.LOWER, 75, -25.0)
    assert entry["measurements"] == 1


def test_sensors_with_their_own_threshold_or_disabled_dont_count(location):
    device = f.make_device(location)
    f.make_measure_point(location, 2, threshold=400)
    f.make_measure_point(location, 3, disabled=True)
    _measure(device, [50, 300, 900])

    entry = _entry(ft.scan(projects=[PROJECT]), location)

    assert entry["max_value"] == 50
    assert entry["excluded_sensors"] == [2, 3]


def test_locations_with_an_active_alarm_are_skipped_unless_included(location):
    device = f.make_device(location)
    _measure(device, [40])
    f.make_alarm(device, value=150, triggered_ago=timedelta(hours=2))

    skipped = _entry(ft.scan(projects=[PROJECT]), location)
    included = _entry(ft.scan(projects=[PROJECT], include_active=True), location)

    assert skipped["action"] == ft.ACTIVE_ALARM and skipped["proposed"] is None
    assert included["max_value"] == 150 and included["action"] == ft.REVIEW
    assert "1 alarm(s) in the window" in included["warnings"][0]


def test_sampling_keeps_one_measurement_per_step_and_device(location):
    device = f.make_device(location)
    _measure(device, [40], ago=timedelta(minutes=50))
    _measure(device, [90], ago=timedelta(minutes=40))  # 10 minutes later: skipped with a 1h step
    _measure(device, [50], ago=timedelta(minutes=5))   # 45 minutes later: skipped too

    sampled = _entry(ft.scan(projects=[PROJECT], step=timedelta(hours=1)), location)
    full = _entry(ft.scan(projects=[PROJECT]), location)

    assert (sampled["max_value"], sampled["measurements"]) == (40, 1)
    assert any("sampled" in warning for warning in sampled["warnings"])
    assert (full["max_value"], full["measurements"]) == (90, 3)


def test_only_the_given_projects_are_scanned(location):
    other = f.make_location(location.account, project_id=PROJECT + 1)
    f.make_device(other)

    ids = {entry["location_id"] for entry in ft.scan(projects=[PROJECT])["locations"]}
    both = {entry["location_id"] for entry in ft.scan(projects=[PROJECT, PROJECT + 1])["locations"]}

    assert ids == {location.pk}
    assert both == {location.pk, other.pk}


def test_a_location_without_measurements_has_no_proposal(location):
    entry = _entry(ft.scan(projects=[PROJECT]), location)
    assert (entry["action"], entry["proposed"], entry["warnings"]) == (ft.NO_DATA, None, [])


# -- file, apply, revert ---------------------------------------------------------

def _scanned(location, pairs=(40, 60)):
    _measure(f.make_device(location), list(pairs))
    findings = ft.scan(projects=[PROJECT])
    return findings, ft.export(findings)


def test_export_writes_the_findings_to_the_fine_tune_folder(location, fine_tune_dir):
    findings, path = _scanned(location)

    assert os.path.dirname(path) == fine_tune_dir
    assert os.path.basename(path).startswith(ft.FILE_PREFIX)
    assert ft.load(path)["locations"] == json.loads(json.dumps(findings["locations"], default=str))
    assert ft.latest_file() == path


def test_apply_writes_the_proposal_and_revert_undoes_it(location, fine_tune_dir):
    findings, path = _scanned(location)

    plan = ft.plan_apply(ft.load(path))
    record = ft.apply(path, plan["changes"])

    assert [entry["location_id"] for entry in plan["changes"]] == [location.pk]
    assert _threshold(location) == 75
    with open(record, encoding="utf-8") as handle:
        recorded = json.load(handle)["locations"][0]
    assert recorded == {
        "location_id": location.pk, "project_id": PROJECT, "name": "Halle Fein", "account_db": f.DB,
        "db": _entry(findings, location)["db"], "old": 100, "new": 75, "action": ft.LOWER}
    # The record is no findings file: --apply without a file still takes the scan.
    assert ft.latest_file() == path

    ft.revert(path, ft.plan_revert(ft.load(path))["changes"])
    assert _threshold(location) == 100


def test_apply_skips_what_changed_since_the_scan(location):
    _findings, path = _scanned(location)
    ProgeoLocation.objects.using(f.DB).filter(pk=location.pk).update(alarm_threshold=90)

    plan = ft.plan_apply(ft.load(path))

    assert plan["changes"] == []
    assert "threshold changed since the scan (100 -> 90)" in plan["skipped"][0][1]
    assert _threshold(location) == 90


def test_apply_skips_a_location_whose_alarm_became_active(location):
    _findings, path = _scanned(location)
    f.make_alarm(f.make_device(location), value=150, triggered_ago=timedelta(minutes=1))

    plan = ft.plan_apply(ft.load(path))

    assert plan["changes"] == [] and "became active" in plan["skipped"][0][1]


def test_apply_refuses_old_findings(location):
    _findings, path = _scanned(location)

    with pytest.raises(ft.FineTuneError, match="older than 7 day"):
        ft.plan_apply(ft.load(path), now=timezone.now() + timedelta(days=8))


def test_revert_leaves_a_threshold_changed_after_the_apply(location):
    _findings, path = _scanned(location)
    ft.apply(path, ft.plan_apply(ft.load(path))["changes"])
    ProgeoLocation.objects.using(f.DB).filter(pk=location.pk).update(alarm_threshold=70)

    plan = ft.plan_revert(ft.load(path))

    assert plan["changes"] == [] and "not the applied 75" in plan["skipped"][0][1]


def test_load_refuses_other_files(tmp_path):
    other = tmp_path / "other.json"
    other.write_text(json.dumps({"kind": "something"}), encoding="utf-8")
    with pytest.raises(ft.FineTuneError, match="no fine-tune file"):
        ft.load(str(other))


# -- the command -----------------------------------------------------------------

def test_command_scans_then_applies_the_newest_file(location, capsys):
    _measure(f.make_device(location), [40, 60])

    call_command("fine_tune_thresholds", "--project", str(PROJECT))
    scanned = capsys.readouterr().out
    assert "lower" in scanned and "100 -> 75 (-25%)" in scanned and "Findings:" in scanned
    assert _threshold(location) == 100  # a scan changes nothing

    call_command("fine_tune_thresholds", "--apply", "--yes")
    assert _threshold(location) == 75


def test_command_apply_without_a_terminal_needs_yes(location, monkeypatch):
    _measure(f.make_device(location), [40, 60])
    call_command("fine_tune_thresholds", "--project", str(PROJECT))
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)

    with pytest.raises(SystemExit):
        call_command("fine_tune_thresholds", "--apply")
    assert _threshold(location) == 100


# -- the staff page (/v1/threshold-fine-tune/) -------------------------------------

URL = "/v1/threshold-fine-tune/"


def _client(user=None):
    from rest_framework.test import APIClient

    client = APIClient()
    client.force_authenticate(user=user or f.make_user(staff=True, perms=("module_admin_thresholds",)))
    return client


def _key(location):
    return f"{f.DB}:{location.pk}"


def test_the_page_needs_staff_and_the_permission(location):
    _scanned(location)
    plain = f.make_user(perms=("module_admin_thresholds",))
    staff = f.make_user(staff=True)

    assert _client(plain).get(URL).status_code == 403
    assert _client(staff).get(URL).status_code == 403
    assert _client().get(URL).status_code == 200


def test_lists_the_files_and_reads_one_with_the_live_threshold(location):
    _findings, path = _scanned(location)
    name = os.path.basename(path)
    ProgeoLocation.objects.using(f.DB).filter(pk=location.pk).update(alarm_threshold=90)
    client = _client()

    files = client.get(URL).json()["files"]
    findings = client.get(f"{URL}{name}/").json()["findings"]

    assert [item["file"] for item in files] == [name]
    assert files[0]["locations"] == 1 and files[0]["applied"] == 0
    entry = findings["locations"][0]
    assert (entry["key"], entry["live_threshold"], entry["current_threshold"]) == (_key(location), 90, 100)
    assert findings["stale"] is None


def test_reading_refuses_other_paths(location):
    _scanned(location)
    client = _client()
    assert client.get(f"{URL}..%2Fsettings.py/").status_code in (400, 404)
    assert client.get(f"{URL}applied_x.json/").status_code == 400
    assert client.get(f"{URL}fine_tune_missing.json/").status_code == 404


def test_apply_writes_the_picked_threshold_and_keeps_revert_working(location):
    _findings, path = _scanned(location)  # max 60 -> proposed 75
    name = os.path.basename(path)

    response = _client().post(f"{URL}{name}/apply/", {"thresholds": {_key(location): 80}}, format="json")

    assert response.status_code == 200, response.content
    assert [(row["old"], row["new"]) for row in response.json()["applied"]] == [(100, 80)]
    assert _threshold(location) == 80
    entry = ft.load(path)["locations"][0]
    assert (entry["proposed"], entry["action"], entry["applied"]["new"]) == (80, ft.LOWER, 80)
    assert entry["scan_proposal"]["proposed"] == 75
    # The CLI doesn't apply it a second time, --revert goes back to the scanned threshold.
    assert ft.plan_apply(ft.load(path))["changes"] == []
    ft.revert(path, ft.plan_revert(ft.load(path))["changes"])
    assert _threshold(location) == 100


def test_apply_again_from_the_same_file(location):
    _findings, path = _scanned(location)
    name = os.path.basename(path)
    client = _client()
    client.post(f"{URL}{name}/apply/", {"thresholds": {_key(location): 80}}, format="json")

    response = client.post(f"{URL}{name}/apply/", {"thresholds": {_key(location): 78}}, format="json")

    assert [(row["old"], row["new"]) for row in response.json()["applied"]] == [(80, 78)]
    assert _threshold(location) == 78


def test_apply_skips_what_changed_and_nonsense(location):
    _findings, path = _scanned(location)
    name = os.path.basename(path)
    ProgeoLocation.objects.using(f.DB).filter(pk=location.pk).update(alarm_threshold=90)

    body = {"thresholds": {_key(location): 80, "default:999999": 50}}
    skipped = _client().post(f"{URL}{name}/apply/", body, format="json").json()["skipped"]

    reasons = {item["key"]: item["reason"] for item in skipped}
    assert "threshold changed since the scan (100 -> 90)" in reasons[_key(location)]
    assert "not in the file" in reasons["default:999999"]
    assert _threshold(location) == 90


def test_apply_refuses_invalid_thresholds(location):
    _findings, path = _scanned(location)
    name = os.path.basename(path)

    skipped = _client().post(f"{URL}{name}/apply/", {"thresholds": {_key(location): 0}}, format="json").json()

    assert "invalid threshold" in skipped["skipped"][0]["reason"]
    assert _threshold(location) == 100


def test_apply_refuses_old_files(location, monkeypatch):
    _findings, path = _scanned(location)
    findings = ft.load(path)
    findings["created_at"] = (timezone.now() - timedelta(days=8)).isoformat()
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(findings, handle)
    name = os.path.basename(path)
    client = _client()

    assert "older than 7 day" in client.get(f"{URL}{name}/").json()["findings"]["stale"]
    response = client.post(f"{URL}{name}/apply/", {"thresholds": {_key(location): 80}}, format="json")
    assert response.status_code == 409
    assert _threshold(location) == 100


def test_remove_drops_entries_from_the_file(location):
    other = f.make_location(location.account, project_id=PROJECT, alarm_threshold=100, name="Halle Zwei")
    _findings, path = _scanned(location)
    name = os.path.basename(path)

    response = _client().post(f"{URL}{name}/remove/", {"keys": [_key(other)]}, format="json")

    assert response.json()["removed"] == 1
    remaining = ft.load(path)
    assert [entry["location_id"] for entry in remaining["locations"]] == [location.pk]
    assert remaining["summary"] == {ft.LOWER: 1}
