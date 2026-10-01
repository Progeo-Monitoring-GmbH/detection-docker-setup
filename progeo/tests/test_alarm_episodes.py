"""Flapping alarms: merged into episodes for the Ereignisverlauf timeline and
the Verdachtsstellen "since"/"resolved" dates. Pure logic on stand-in
objects - no database needed."""
from datetime import timedelta
from types import SimpleNamespace

from django.utils import timezone

from progeo.v1.models import ProgeoAlarm
from progeo.v1.viewsets.alarm_viewset import AlarmViewSet
from progeo.v1.viewsets.locations_viewset import LocationViewSet

NOW = timezone.now()
GAP = ProgeoAlarm.EPISODE_GAP


def alarm(triggered_min_ago, normalized_min_ago=None, sensor_id=1, peak=150,
          severity=ProgeoAlarm.Severity.ALARM, evaluated_min_ago=None, evaluator=None):
    return SimpleNamespace(
        sensor_id=sensor_id,
        triggered_at=NOW - timedelta(minutes=triggered_min_ago) if triggered_min_ago is not None else None,
        normalized_at=NOW - timedelta(minutes=normalized_min_ago) if normalized_min_ago is not None else None,
        evaluated_at=NOW - timedelta(minutes=evaluated_min_ago) if evaluated_min_ago is not None else None,
        evaluated_by=SimpleNamespace(username=evaluator) if evaluator else None,
        last_fetched=None,
        peak_value=peak,
        severity=severity,
    )


# -- LocationViewSet._group_alarm_episodes ---------------------------------

def test_episode_gap_is_one_hour():
    assert GAP == timedelta(hours=1)


def test_retriggers_within_the_gap_form_one_episode():
    alarms = [alarm(60, 55), alarm(40, 35), alarm(20, 15)]
    episodes = LocationViewSet._group_alarm_episodes(alarms)
    assert [len(episode) for episode in episodes] == [3]


def test_retrigger_exactly_at_the_gap_still_merges():
    first = alarm(200, 120)
    second = alarm(60)  # triggered exactly GAP after the first normalized
    assert len(LocationViewSet._group_alarm_episodes([first, second])) == 1


def test_retrigger_after_the_gap_starts_a_new_episode():
    episodes = LocationViewSet._group_alarm_episodes([alarm(300, 290), alarm(60, 50)])
    assert [len(episode) for episode in episodes] == [1, 1]


def test_open_alarm_absorbs_later_triggers():
    episodes = LocationViewSet._group_alarm_episodes([alarm(500), alarm(10)])
    assert [len(episode) for episode in episodes] == [2]


def test_episodes_are_per_sensor():
    episodes = LocationViewSet._group_alarm_episodes([alarm(30, 25, sensor_id=1), alarm(20, 15, sensor_id=2)])
    assert sorted(episode[0].sensor_id for episode in episodes) == [1, 2]


def test_input_order_does_not_matter():
    alarms = [alarm(20, 15), alarm(60, 55), alarm(40, 35)]
    episodes = LocationViewSet._group_alarm_episodes(alarms)
    assert [a.triggered_at for a in episodes[0]] == sorted(a.triggered_at for a in alarms)


def test_alarms_without_trigger_time_stay_single():
    episodes = LocationViewSet._group_alarm_episodes([alarm(None, 5), alarm(None, 4)])
    assert [len(episode) for episode in episodes] == [1, 1]


# -- LocationViewSet._build_timeline_events --------------------------------

def _timeline(alarms, cutoff_min_ago=10_000):
    return LocationViewSet._build_timeline_events([], alarms, NOW - timedelta(minutes=cutoff_min_ago))


def test_timeline_reports_one_trigger_and_resolution_per_episode():
    events = _timeline([alarm(60, 55, peak=110), alarm(40, 35, peak=280), alarm(20, 15, peak=120)])

    kinds = [event["kind"] for event in events]
    assert kinds == ["alarm_resolved", "alarm_triggered"]
    triggered = events[1]
    assert triggered["occurrences"] == 3
    assert triggered["max_value"] == 280
    assert triggered["at"] == NOW - timedelta(minutes=60)
    assert events[0]["at"] == NOW - timedelta(minutes=15)


def test_open_episode_has_no_resolution():
    events = _timeline([alarm(60, 55), alarm(30)])
    assert [event["kind"] for event in events] == ["alarm_triggered"]


def test_first_acknowledgement_of_an_episode_is_reported_once():
    events = _timeline([
        alarm(60, 55, evaluated_min_ago=58, evaluator="anna"),
        alarm(40, 35, evaluated_min_ago=38, evaluator="ben"),
    ])
    acknowledged = [event for event in events if event["kind"] == "alarm_acknowledged"]
    assert acknowledged == [{"kind": "alarm_acknowledged", "at": NOW - timedelta(minutes=58), "detail": "anna"}]


def test_events_before_the_cutoff_are_dropped():
    events = _timeline([alarm(600, 590)], cutoff_min_ago=60)
    assert events == []


def test_timeline_is_newest_first():
    events = _timeline([alarm(600, 590), alarm(30, 20)])
    assert [event["at"] for event in events] == sorted((event["at"] for event in events), reverse=True)


# -- AlarmViewSet._current_episode -----------------------------------------

def test_current_episode_of_resolved_flapping_sensor():
    since, resolved = AlarmViewSet._current_episode([alarm(600, 590), alarm(60, 55), alarm(40, 35)])
    assert since == NOW - timedelta(minutes=60)
    assert resolved == NOW - timedelta(minutes=35)


def test_current_episode_still_open():
    since, resolved = AlarmViewSet._current_episode([alarm(60, 55), alarm(30)])
    assert since == NOW - timedelta(minutes=60)
    assert resolved is None


def test_current_episode_empty():
    assert AlarmViewSet._current_episode([]) == (None, None)
