"""Status tab data through the API: /v1/alarm/location_summary/,
/v1/alarm/clusters/ (Verdachtsstellen) and /v1/location/<id>/timeline/.

The pure helpers behind them (_build_cluster, _group_alarm_episodes,
_build_timeline_events) are covered elsewhere; these tests pin the HTTP
contract: scoping, windows/clamping, response shape and sort order.
"""
from datetime import datetime, timedelta

import pytest
from django.utils import timezone

from progeo.tests import factories as f
from progeo.v1.models import SMS, EMail, ProgeoAlarm

MEASURE = ("module_measurements_enabled",)
NOTIFY = ("module_notifications_enabled",)


def _ts(value):
    return datetime.fromisoformat(value) if value else None


@pytest.fixture
def world():
    account = f.make_account()
    location = f.make_location(account)
    other_location = f.make_location(account)
    device = f.make_device(location, mac="AA:BB")
    member = f.make_user(perms=MEASURE + NOTIFY, accounts=[account])
    return account, location, other_location, device, member


# -- location_summary --------------------------------------------------------

def _summary(api_client, **params):
    response = api_client.get("/v1/alarm/location_summary/", params)
    assert response.status_code == 200, response.content
    return response.json()["locations"]


def test_summary_counts_alarms_and_active_ones_per_location(api_client, world):
    _account, location, other_location, device, member = world
    f.make_alarm(device, triggered_ago=f.minutes(30))
    f.make_alarm(device, triggered_ago=f.minutes(90), normalized_ago=f.minutes(60))
    f.make_alarm(f.make_device(other_location), triggered_ago=f.minutes(5))
    api_client.force_authenticate(user=member)

    locations = _summary(api_client)

    assert locations == {
        str(location.id): {"count": 2, "active": 1},
        str(other_location.id): {"count": 1, "active": 1},
    }


def test_summary_ids_filter(api_client, world):
    _account, location, other_location, device, member = world
    f.make_alarm(device, triggered_ago=f.minutes(30))
    f.make_alarm(f.make_device(other_location), triggered_ago=f.minutes(5))
    api_client.force_authenticate(user=member)

    assert list(_summary(api_client, ids=f"{other_location.id}, ")) == [str(other_location.id)]


def test_summary_rejects_non_integer_ids(api_client, world):
    api_client.force_authenticate(user=world[4])

    response = api_client.get("/v1/alarm/location_summary/", {"ids": "1,x"})

    assert response.status_code == 400
    assert response.json()["reason"] == "ids must be a comma-separated list of integers"


def test_summary_keeps_old_active_alarms_but_drops_old_resolved_ones(api_client, world):
    _account, location, _other, device, member = world
    old = timedelta(days=30)
    f.make_alarm(device, triggered_ago=old)  # still open
    f.make_alarm(device, triggered_ago=old, normalized_ago=old - timedelta(hours=1))
    api_client.force_authenticate(user=member)

    assert _summary(api_client) == {str(location.id): {"count": 1, "active": 1}}
    assert _summary(api_client, days=60) == {str(location.id): {"count": 2, "active": 1}}


@pytest.mark.parametrize("days, counted", [("0", False), ("-3", False), ("abc", True), ("2", True), ("100000", True)])
def test_summary_days_are_clamped(api_client, world, days, counted):
    _account, location, _other, device, member = world
    # Resolved, triggered 36h ago: inside the default 14 days, outside 1 day.
    f.make_alarm(device, triggered_ago=timedelta(hours=36), normalized_ago=timedelta(hours=35))
    api_client.force_authenticate(user=member)

    assert (str(location.id) in _summary(api_client, days=days)) is counted


def test_summary_is_scoped_for_single_access_users(api_client, world):
    _account, location, other_location, device, _member = world
    f.make_alarm(device, triggered_ago=f.minutes(30))
    f.make_alarm(f.make_device(other_location), triggered_ago=f.minutes(5))
    single = f.make_user(perms=MEASURE)
    f.make_access(other_location, single)
    api_client.force_authenticate(user=single)

    assert list(_summary(api_client)) == [str(other_location.id)]


def test_summary_for_user_without_access_is_empty(api_client, world):
    f.make_alarm(world[3], triggered_ago=f.minutes(30))
    api_client.force_authenticate(user=f.make_user(perms=MEASURE))

    assert _summary(api_client) == {}


def test_summary_requires_permission(api_client, world):
    api_client.force_authenticate(user=f.make_user(accounts=[world[0]]))

    assert api_client.get("/v1/alarm/location_summary/").status_code == 403


# -- clusters ----------------------------------------------------------------

@pytest.fixture
def cluster_world(world):
    account, location, _other, device, member = world
    acker = f.make_user(username=f.unique("acker"))
    alarms = {
        "neu_low": f.make_alarm(device, sensor_id=1, value=150, triggered_ago=f.minutes(30)),
        "quittiert": f.make_alarm(
            device, sensor_id=2, value=300, triggered_ago=f.minutes(40), status=ProgeoAlarm.Status.QUITTIERT,
            evaluated_by_id=acker.id, evaluated_at=timezone.now() - f.minutes(20),
        ),
        "geloest": f.make_alarm(device, sensor_id=3, value=400, triggered_ago=f.minutes(60),
                                normalized_ago=f.minutes(10)),
        "neu_high": f.make_alarm(device, sensor_id=4, value=250, triggered_ago=f.minutes(15)),
    }
    return location, member, acker, alarms


def _clusters(api_client, location, **params):
    response = api_client.get("/v1/alarm/clusters/", {"location": location.id, **params})
    assert response.status_code == 200, response.content
    return response.json()


def test_clusters_are_sorted_neu_first_then_by_reading(api_client, cluster_world):
    location, member, _acker, _alarms = cluster_world
    api_client.force_authenticate(user=member)

    clusters = _clusters(api_client, location)["clusters"]

    assert [(c["sensor_id"], c["state"]) for c in clusters] == [
        (4, "neu"), (1, "neu"), (2, "quittiert"), (3, "geloest"),
    ]


def test_cluster_shape_and_lifecycle_fields(api_client, cluster_world):
    location, member, acker, alarms = cluster_world
    api_client.force_authenticate(user=member)

    clusters = {c["sensor_id"]: c for c in _clusters(api_client, location)["clusters"]}

    open_neu = clusters[1]
    assert open_neu["id"] == "sensor-1"
    assert open_neu["active"] is True
    assert open_neu["resolved_at"] is None
    assert _ts(open_neu["since"]) == alarms["neu_low"].triggered_at
    assert open_neu["pending_ack_alarm_ids"] == [alarms["neu_low"].id]
    assert open_neu["alarm_ids"] == [alarms["neu_low"].id]
    assert open_neu["max_value"] == 150
    assert open_neu["device_label"] == "AA:BB"

    acked = clusters[2]
    assert acked["ack_by"] == acker.username
    assert acked["pending_ack_alarm_ids"] == []
    assert acked["severity"] == ProgeoAlarm.Severity.KRITISCH  # 300 = 3x threshold

    resolved = clusters[3]
    assert resolved["active"] is False
    assert _ts(resolved["resolved_at"]) == alarms["geloest"].normalized_at
    assert _ts(resolved["since"]) == alarms["geloest"].triggered_at
    # Resolved without acknowledgement: still acknowledgeable.
    assert resolved["pending_ack_alarm_ids"] == [alarms["geloest"].id]


def test_clusters_top_sensors(api_client, world, cluster_world):
    location, member, _acker, _alarms = cluster_world
    device = world[3]
    f.make_alarm(device, sensor_id=1, value=120, triggered_ago=f.minutes(5))
    api_client.force_authenticate(user=member)

    top = _clusters(api_client, location)["top_sensors"]

    assert top[0] == {"sensor_id": 1, "alarm_count": 2, "max_value": 150}
    assert [row["sensor_id"] for row in top[1:]] == [3, 2, 4]  # ties by peak reading


def test_clusters_need_a_location(api_client, world):
    api_client.force_authenticate(user=world[4])

    response = api_client.get("/v1/alarm/clusters/")

    assert response.status_code == 400
    assert response.json()["reason"] == "location is required"


def test_clusters_reject_non_numeric_location(api_client, world):
    api_client.force_authenticate(user=world[4])

    response = api_client.get("/v1/alarm/clusters/", {"location": "abc"})

    assert response.status_code == 400


def test_clusters_of_a_foreign_location_are_empty(api_client, cluster_world):
    location, _member, _acker, _alarms = cluster_world
    outsider = f.make_user(perms=MEASURE, accounts=[f.make_account()])
    api_client.force_authenticate(user=outsider)

    assert _clusters(api_client, location) == {"clusters": [], "top_sensors": [], "success": True}


def test_clusters_window_drops_old_resolved_alarms(api_client, world):
    _account, location, _other, device, member = world
    f.make_alarm(device, sensor_id=7, triggered_ago=timedelta(days=20), normalized_ago=timedelta(days=19))
    api_client.force_authenticate(user=member)

    assert _clusters(api_client, location)["clusters"] == []
    assert [c["sensor_id"] for c in _clusters(api_client, location, days=30)["clusters"]] == [7]


# -- timeline ----------------------------------------------------------------

def _email(location, ago, subject="Mail", sent=True, error=None):
    mail = EMail.objects.using(f.DB).create(
        location=location, raw_hash=f.unique("mail"), sent_to="a@example.com", subject=subject,
        message="body", files="", sent=sent, error=error,
    )
    EMail.objects.using(f.DB).filter(pk=mail.pk).update(created=timezone.now() - ago)
    return mail


def _sms(location, ago, sent=True, error=None):
    message = SMS.objects.using(f.DB).create(
        location=location, sent_to="+4915100", message="body", sent=sent, error=error,
    )
    SMS.objects.using(f.DB).filter(pk=message.pk).update(created=timezone.now() - ago)
    return message


def _timeline(api_client, location, **params):
    response = api_client.get(f"/v1/location/{location.id}/timeline/", params)
    assert response.status_code == 200, response.content
    return response.json()["events"]


def test_timeline_merges_mails_and_alarm_events_newest_first(api_client, world):
    _account, location, _other, device, member = world
    _email(location, f.minutes(50), subject="Störung", sent=False, error="SMTP not configured")
    f.make_alarm(device, triggered_ago=f.minutes(40), normalized_ago=f.minutes(10))
    api_client.force_authenticate(user=member)

    events = _timeline(api_client, location)

    assert [event["kind"] for event in events] == ["alarm_resolved", "alarm_triggered", "email"]
    mail = events[2]
    assert (mail["title"], mail["success"], mail["error"]) == ("Störung", False, "SMTP not configured")
    assert events[1]["occurrences"] == 1


def test_timeline_only_shows_the_requested_location(api_client, world):
    _account, location, other_location, _device, member = world
    _email(other_location, f.minutes(5))
    f.make_alarm(f.make_device(other_location), triggered_ago=f.minutes(5))
    api_client.force_authenticate(user=member)

    assert _timeline(api_client, location) == []


@pytest.mark.parametrize(
    "days, expected_subjects",
    [
        (None, ["2d", "20d"]),       # default 30 days
        ("abc", ["2d", "20d"]),      # invalid -> default
        ("1", []),
        ("0", []),                   # clamped up to 1 day
        ("-10", []),
        ("3", ["2d"]),
        ("365", ["2d", "20d", "300d"]),
        ("5000", ["2d", "20d", "300d"]),  # clamped down to 365
    ],
)
def test_timeline_days_are_clamped(api_client, world, days, expected_subjects):
    _account, location, _other, _device, member = world
    for age in (2, 20, 300, 400):
        _email(location, timedelta(days=age), subject=f"{age}d")
    api_client.force_authenticate(user=member)

    params = {"days": days} if days is not None else {}
    assert [event["title"] for event in _timeline(api_client, location, **params)] == expected_subjects


def test_timeline_of_a_foreign_location_is_refused(api_client, world):
    _account, location, _other, _device, _member = world
    outsider = f.make_user(perms=NOTIFY, accounts=[f.make_account()])
    api_client.force_authenticate(user=outsider)

    response = api_client.get(f"/v1/location/{location.id}/timeline/")

    assert response.json() == {"reason": "Location not found", "success": False}


def test_timeline_requires_notifications_permission(api_client, world):
    api_client.force_authenticate(user=f.make_user(perms=MEASURE, accounts=[world[0]]))

    response = api_client.get(f"/v1/location/{world[1].id}/timeline/")

    assert response.status_code == 403
    assert response.json()["missing_permissions"] == ["module_notifications_enabled"]



def test_timeline_includes_sms_of_the_location(api_client, world):
    _account, location, other, _device, member = world
    _email(location, f.minutes(30))
    _sms(location, f.minutes(20), sent=False, error="Esendex API answered HTTP 401.")
    _sms(other, f.minutes(10))
    api_client.force_authenticate(user=member)

    events = _timeline(api_client, location)

    assert [event["kind"] for event in events] == ["sms", "email"]
    sms = events[0]
    assert (sms["detail"], sms["success"], sms["error"]) == ("+4915100", False, "Esendex API answered HTTP 401.")
