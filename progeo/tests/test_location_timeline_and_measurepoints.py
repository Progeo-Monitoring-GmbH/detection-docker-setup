import pytest
from django.contrib.auth.models import User
from django.utils import timezone

from progeo.v1.models import (
    EMail,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoLocation,
    ProgeoMeasurement,
)
from progeo.v1.serializers import EMailSerializer, ProgeoAccessSerializer
from progeo.v1.viewsets.locations_viewset import LocationViewSet

# -- ProgeoLocation.pe_geschaltet -----------------------------------------

def test_pe_geschaltet_defaults_to_false():
    location = ProgeoLocation()
    assert location.pe_geschaltet is False


# -- ProgeoAccessSerializer.is_staff ---------------------------------------

@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_access_serializer_reports_is_staff_for_staff_and_customer_users():
    staff_user = User.objects.using("default").create(username="objektleitung-1", is_staff=True)
    customer_user = User.objects.using("default").create(username="kunde-1", is_staff=False)
    location = ProgeoLocation.objects.using("default").create()

    from progeo.v1.models import ProgeoAccess

    staff_rule = ProgeoAccess.objects.using("default").create(
        location=location, user=staff_user, transport=1, type=1
    )
    customer_rule = ProgeoAccess.objects.using("default").create(
        location=location, user=customer_user, transport=1, type=1
    )

    assert ProgeoAccessSerializer(staff_rule).data["is_staff"] is True
    assert ProgeoAccessSerializer(customer_rule).data["is_staff"] is False


# -- EMailSerializer --------------------------------------------------------

@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_email_serializer_fields():
    location = ProgeoLocation.objects.using("default").create(name="Test-Objekt")
    email = EMail.objects.using("default").create(
        location=location,
        raw_hash="email-serializer-test",
        sent_to="a@example.com,b@example.com",
        subject="Monatsbericht",
        message="body",
        files="",
        sent=True,
    )

    data = EMailSerializer(email).data
    assert data["subject"] == "Monatsbericht"
    assert data["sent_to"] == "a@example.com,b@example.com"
    assert data["sent"] is True
    assert data["error"] is None


# -- LocationViewSet._build_timeline_events (pure merge/sort) --------------

@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_build_timeline_events_merges_and_sorts_emails_and_alarms():
    now = timezone.now()
    location = ProgeoLocation.objects.using("default").create(alarm_threshold=100)
    device = ProgeoDevice.objects.using("default").create(raw_hash="timeline-device", location=location)
    measurement = ProgeoMeasurement.objects.using("default").create(device=device, raw_data={})

    email = EMail.objects.using("default").create(
        location=location,
        raw_hash="timeline-email",
        sent_to="a@example.com",
        subject="Alarm",
        message="body",
        files="",
        sent=True,
        created=now,
    )
    # created has auto_now_add=True, so force the timestamp we actually want to test ordering.
    EMail.objects.using("default").filter(pk=email.pk).update(created=now)
    email.refresh_from_db(using="default")

    alarm = ProgeoAlarm.objects.using("default").create(
        measurement=measurement,
        threshold=100,
        max_value=200,
        status=ProgeoAlarm.Status.GELOEST,
        triggered_at=now - timezone.timedelta(hours=2),
        evaluated_at=now - timezone.timedelta(hours=1),
        normalized_at=now,
    )

    cutoff = now - timezone.timedelta(days=1)
    events = LocationViewSet._build_timeline_events(
        EMail.objects.using("default").filter(pk=email.pk),
        ProgeoAlarm.objects.using("default").filter(pk=alarm.pk),
        cutoff,
    )

    kinds = [event["kind"] for event in events]
    # 4 events: email + triggered + acknowledged + resolved.
    assert kinds.count("email") == 1
    assert "alarm_triggered" in kinds
    assert "alarm_acknowledged" in kinds
    assert "alarm_resolved" in kinds
    # Most recent first.
    assert events == sorted(events, key=lambda event: event["at"], reverse=True)


@pytest.mark.django_db(databases=["unit_tests", "default"])
def test_build_timeline_events_excludes_events_before_cutoff():
    now = timezone.now()
    location = ProgeoLocation.objects.using("default").create(alarm_threshold=100)
    device = ProgeoDevice.objects.using("default").create(raw_hash="timeline-device-2", location=location)
    measurement = ProgeoMeasurement.objects.using("default").create(device=device, raw_data={})

    old_alarm = ProgeoAlarm.objects.using("default").create(
        measurement=measurement,
        threshold=100,
        max_value=150,
        status=ProgeoAlarm.Status.GELOEST,
        triggered_at=now - timezone.timedelta(days=10),
        normalized_at=now - timezone.timedelta(days=9),
    )

    cutoff = now - timezone.timedelta(days=1)
    events = LocationViewSet._build_timeline_events(
        EMail.objects.using("default").none(),
        ProgeoAlarm.objects.using("default").filter(pk=old_alarm.pk),
        cutoff,
    )

    assert events == []
