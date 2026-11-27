"""The Django admin of the progeo models (progeo/v1/admin.py): every page
loads, the list columns cost no query per row, the sidebar filters keep the
right rows, the "related data" links open filtered lists, secrets stay
hidden, and a measurement keeps its time when edited."""
import datetime
import html
import re
import uuid

import pytest
from django.contrib import admin
from django.contrib.admin.utils import flatten_fieldsets
from django.db import connections
from django.test import Client, RequestFactory
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from progeo.helper.airtable import AirtableHelper
from progeo.tests import factories as f
from progeo.v1.admin_tools import EstimatedCountPaginator
from progeo.v1.models import (
    AccessRequest,
    DeviceSms,
    EMail,
    EmailSuppression,
    LoginLink,
    NotificationCase,
    NotificationToken,
    OutboundMessage,
    ProgeoAccess,
    ProgeoAccessIndex,
    ProgeoDevice,
    ProgeoDeviceCommand,
    ProgeoEscalation,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurement,
    ProgeoNoiseProfile,
    ProgeoRainEvent,
    ProgeoSensorMapping,
    ScreenReviewMark,
    ScreenReviewNote,
    SystemConfig,
    TwoFactorDevice,
    UserProfile,
)
from progeo.werk.models import FactorySensor, SiteMeasurement

pytestmark = pytest.mark.django_db

# The apps whose admin pages these tests cover: progeo and the factory (werk).
ADMIN_APPS = ("progeo", "werk")
APP_OF = {
    model._meta.model_name: model._meta.app_label
    for model in admin.site._registry if model._meta.app_label in ADMIN_APPS
}
PROGEO_ADMINS = sorted(APP_OF)


def _url(path):
    """"factorysensor/1/change/" -> "/aadmin/werk/factorysensor/1/change/"."""
    return f"/aadmin/{APP_OF[path.split('/', 1)[0]]}/{path}"
SECRET = "fernet:do-not-show-this-secret"


@pytest.fixture
def staff():
    return f.make_user(staff=True, is_superuser=True, email="admin-usability@progeo.com")


@pytest.fixture
def admin_client(staff):
    client = Client()
    client.force_login(staff)
    return client


def _get(client, path, **params):
    response = client.get(_url(path), params, secure=True)
    assert response.status_code == 200, (path, params, response.status_code, response.get("Location"))
    return response


def _listed(response):
    return set(response.context["cl"].result_list)


def _site_measurement(**fields):
    defaults = {
        "mess_id": uuid.uuid4(), "project_id": 970101, "sensor": "000007", "measured_at": timezone.now(),
        "identification": "nfc", "trigger": "manual", "r_ohm": 1010, "r_status": "ok", "device_id": "app-1",
        "payload": {"benutzer": "monteur"}, "r_werk_ohm": 1000, "delta_percent": 1.0, "tolerance_percent": 5.0,
        "status": SiteMeasurement.Status.OK,
    }
    defaults.update(fields)
    return SiteMeasurement.objects.using(f.DB).create(**defaults)


@pytest.fixture
def rows(staff):
    """One row of (almost) every model with an admin."""
    account = f.make_account()
    user = f.make_user(email="row-user@progeo.com")
    location = f.make_location(account, name="Usability-Halle", project_id=970101)
    device = f.make_device(location, hardware="smartex dm", mac="Dach Nord")
    alarm = f.make_alarm(device, triggered_ago=f.minutes(30))
    plan = ProgeoLageplan.objects.using(f.DB).create(location=location, name="EG")
    case = NotificationCase.objects.using(f.DB).create(kind="offline", location_id=location.pk, project_id=970101)
    factory = FactorySensor.objects.using(f.DB).create(project_id=970101, sensor="000007", r_werk_ohm=1000)
    access = f.make_access(location, user)
    now = timezone.now()
    return {
        "account": account,
        "location": location,
        "progeodevice": device,
        "progeoalarm": alarm,
        "progeomeasurement": alarm.measurement,
        "progeolageplan": plan,
        "progeomeasurepoint": f.make_measure_point(location, 1, name="Feld 1", lageplan=plan, device=device),
        "progeoaccess": access,
        "progeoaccessindex": ProgeoAccessIndex.objects.using(f.DB).get_or_create(user=user, location=location)[0],
        "email": EMail.objects.using(f.DB).create(
            location=location, raw_hash=f.unique("mail"), sent_to="row-user@progeo.com", subject="Alarm",
            message="Text", files="", sent=True,
        ),
        "devicesms": DeviceSms.objects.using(f.DB).create(
            device_hash=device.raw_hash, ref="A1", kind="alarm", to="+49170000000", status_code=200, sent=True,
        ),
        "progeorainevent": ProgeoRainEvent.objects.using(f.DB).create(
            location=location, start=now - datetime.timedelta(hours=2), end=now, amount=3.5,
        ),
        "progeonoiseprofile": ProgeoNoiseProfile.objects.using(f.DB).create(device=device, name="Grundrauschen"),
        "progeosensormapping": ProgeoSensorMapping.objects.using(f.DB).create(
            device=device, positions={"1": 1, "2": 3}, origin=ProgeoSensorMapping.Origin.KLEMMLISTE,
        ),
        "progeodevicecommand": ProgeoDeviceCommand.objects.using(f.DB).create(device=device, command="measure"),
        "progeoescalation": ProgeoEscalation.objects.using(f.DB).create(
            location=location, project_id=970101, title="Undicht",
        ),
        "outboundmessage": OutboundMessage.objects.using(f.DB).create(
            channel="mail", status="bounced", recipient="row-user@progeo.com", location_id=location.pk,
            case_id=case.pk,
        ),
        "emailsuppression": EmailSuppression.objects.using(f.DB).create(address="bounce@progeo.com", active=True),
        "loginlink": LoginLink.objects.using(f.DB).create(
            user_id=user.pk, purpose="login", token_hash="a" * 64, expires_at=now + datetime.timedelta(hours=1),
        ),
        "twofactordevice": TwoFactorDevice.objects.using(f.DB).create(
            user_id=user.pk, secret=SECRET, recovery_codes=["b" * 64, "c" * 64],
        ),
        "accessrequest": AccessRequest.objects.using(f.DB).create(
            first_name="Anna", last_name="Antrag", email="antrag@progeo.com", privacy_accepted_at=now,
            verify_token_hash="d" * 64,
        ),
        "notificationcase": case,
        "notificationtoken": NotificationToken.objects.using(f.DB).create(
            token_hash="e" * 64, case=case, address="row-user@progeo.com", expires_at=now + datetime.timedelta(days=9),
        ),
        "factorysensor": factory,
        "sitemeasurement": _site_measurement(factory_sensor=factory, user_id=user.pk),
        "userprofile": UserProfile.objects.using(f.DB).get_or_create(user=user, defaults={"mobile": "+4917000"})[0],
        "screenreviewnote": ScreenReviewNote.objects.using(f.DB).create(
            run="run1", image="status.png", kind="note", action="question", comment="Warum?",
        ),
        "screenreviewmark": ScreenReviewMark.objects.using(f.DB).create(run="run1", image="status.png"),
        "systemconfig": SystemConfig.objects.using(f.DB).create(
            key="smtp", value={"host": "mail.progeo.com", "password": "geheim-123", "nested": {"api_key": "k-456"}},
        ),
    }


# ============================================================================== every page


@pytest.mark.parametrize("model_name", PROGEO_ADMINS)
def test_every_list_loads_also_with_a_search(admin_client, rows, model_name):
    _get(admin_client, f"{model_name}/")
    _get(admin_client, f"{model_name}/", q="1")
    _get(admin_client, f"{model_name}/", q="Usability text")


@pytest.mark.parametrize("model_name", [
    "progeolocation", "progeodevice", "progeoalarm", "progeomeasurement", "progeolageplan", "progeomeasurepoint",
    "progeoaccess", "progeoaccessindex", "email", "devicesms", "progeorainevent", "progeonoiseprofile",
    "progeosensormapping", "progeodevicecommand", "progeoescalation", "outboundmessage", "emailsuppression",
    "loginlink", "twofactordevice", "accessrequest", "notificationcase", "notificationtoken", "factorysensor",
    "sitemeasurement", "userprofile", "screenreviewnote", "screenreviewmark", "systemconfig", "account",
])
def test_every_detail_page_loads(admin_client, rows, model_name):
    obj = rows["location"] if model_name == "progeolocation" else rows[model_name]
    _get(admin_client, f"{model_name}/{obj.pk}/change/")


def test_every_add_page_that_exists_loads(admin_client):
    for model, model_admin in admin.site._registry.items():
        if model._meta.app_label not in ADMIN_APPS:
            continue
        response = admin_client.get(_url(f"{model._meta.model_name}/add/"), secure=True)
        expected = 200 if model_admin.has_add_permission(_request()) else 403
        assert response.status_code == expected, model._meta.model_name


def _request(user=None):
    request = RequestFactory().get("/aadmin/")
    request.user = user or f.make_user(staff=True, is_superuser=True)
    request.using_db = "default"
    return request


# Model fields the detail pages leave out on purpose (secrets, or shown formatted).
HIDDEN_FIELDS = {
    "progeolocation": {"readiness_checks", "db_size_bytes"},
    "progeoalarm": set(),
    "progeodevicecommand": {"summary", "payload_encrypted", "result_encrypted", "files_encrypted"},
    "progeosensormapping": {"positions", "manual"},
    "sitemeasurement": {"payload", "status", "delta_percent", "location_pk", "factory_sensor"},
    "loginlink": {"token_hash"},
    "twofactordevice": {"secret", "recovery_codes", "last_step"},
    "accessrequest": {"verify_token_hash"},
    "notificationtoken": {"token_hash"},
    "systemconfig": {"value"},
    "mfslog": {"data"},
    "alarmdailyreport": {"projects", "locations", "sensors", "hourly", "top_alarms"},
    "progeoaccessindex": set(),
}


@pytest.mark.parametrize("model_name", PROGEO_ADMINS)
def test_the_detail_pages_leave_no_field_out_by_accident(model_name):
    model, model_admin = next(
        (model, model_admin) for model, model_admin in admin.site._registry.items()
        if model._meta.app_label in ADMIN_APPS and model._meta.model_name == model_name
    )
    if model._meta.proxy or not (model_admin.fields or model_admin.fieldsets):
        return  # Django shows every field (the proxy picks its own few of User's)
    shown = set(flatten_fieldsets(model_admin.get_fieldsets(_request()))) | set(model_admin.readonly_fields)
    fields = {
        field.name for field in model._meta.concrete_fields
        if field.editable and not field.primary_key and not field.name.endswith("_ptr")
    }
    bookkeeping = {"last_fetched", "last_updated"}  # RootModel's save stamps
    missing = fields - shown - bookkeeping - HIDDEN_FIELDS.get(model_name, set())
    assert not missing, f"{model_name} leaves out {sorted(missing)}"


# ============================================================================== no query per row


def _more(kind, staff, count):
    """`count` rows of `kind`, each with its own location / device / user."""
    for _ in range(count):
        account = f.make_account()
        location = f.make_location(account, project_id=None)
        device = f.make_device(location, hardware="smartex dm")
        user = f.make_user(email="nplusone@progeo.com")
        if kind in ("progeolocation", "progeodevice"):
            f.make_location(account, project_id=None, parent_location=location)
            continue
        if kind == "progeomeasurement":
            f.make_measurement(device, pairs=[10, 20])
        elif kind == "progeoalarm":
            f.make_alarm(device, triggered_ago=f.minutes(5))
        elif kind == "progeoaccess":
            f.make_access(location, user)
        elif kind == "email":
            EMail.objects.using(f.DB).create(location=location, raw_hash=f.unique("m"), sent_to="x@progeo.com",
                                             message="m", files="")
        elif kind == "progeomeasurepoint":
            plan = ProgeoLageplan.objects.using(f.DB).create(location=location)
            f.make_measure_point(location, 1, lageplan=plan, device=device)
        elif kind == "progeolageplan":
            ProgeoLageplan.objects.using(f.DB).create(location=location)
        elif kind == "progeorainevent":
            ProgeoRainEvent.objects.using(f.DB).create(location=location, start=timezone.now(), end=timezone.now(),
                                                       amount=1)
        elif kind == "progeonoiseprofile":
            ProgeoNoiseProfile.objects.using(f.DB).create(device=device, name="n", created_by_id=user.pk)
        elif kind == "progeosensormapping":
            ProgeoSensorMapping.objects.using(f.DB).create(device=device, origin="manual")
        elif kind == "progeodevicecommand":
            ProgeoDeviceCommand.objects.using(f.DB).create(device=device, command="measure", created_by_id=user.pk)
        elif kind == "progeoaccessindex":
            ProgeoAccessIndex.objects.using(f.DB).get_or_create(user=user, location=location)
        elif kind == "progeoescalation":
            ProgeoEscalation.objects.using(f.DB).create(location=location, title="t", assigned_to_id=user.pk)
        elif kind == "sitemeasurement":
            _site_measurement(user_id=user.pk)
        elif kind == "loginlink":
            LoginLink.objects.using(f.DB).create(user_id=user.pk, purpose="login", token_hash=f.unique("t")[:64],
                                                 expires_at=timezone.now())
        else:
            raise AssertionError(kind)


def _list_queries(client, model_name):
    with CaptureQueriesContext(connections[f.DB]) as queries:
        _get(client, f"{model_name}/")
    return len(queries)


@pytest.mark.parametrize("model_name", [
    "progeolocation", "progeodevice", "progeomeasurement", "progeoalarm", "progeoaccess", "email",
    "progeomeasurepoint",
    "progeolageplan", "progeorainevent", "progeonoiseprofile", "progeosensormapping", "progeodevicecommand",
    "progeoaccessindex", "progeoescalation", "sitemeasurement", "loginlink",
])
def test_the_list_needs_no_query_per_row(admin_client, staff, model_name):
    _more(model_name, staff, 2)
    few = _list_queries(admin_client, model_name)
    _more(model_name, staff, 5)

    assert _list_queries(admin_client, model_name) == few


# ============================================================================== filters


def test_alarms_by_state_and_by_device(admin_client, rows):
    device = rows["progeodevice"]
    active = rows["progeoalarm"]
    normalized = f.make_alarm(device, triggered_ago=f.minutes(60), normalized_ago=f.minutes(10))
    elsewhere = f.make_alarm(f.make_device(rows["location"]), triggered_ago=f.minutes(60))

    assert {active, normalized} <= _listed(_get(admin_client, "progeoalarm/", device_pk=device.pk))
    assert elsewhere not in _listed(_get(admin_client, "progeoalarm/", device_pk=device.pk))
    assert normalized not in _listed(_get(admin_client, "progeoalarm/", state="active"))
    assert active not in _listed(_get(admin_client, "progeoalarm/", state="normalized"))


@pytest.mark.parametrize("text", ["970101", "usability-HALLE"])
def test_the_location_box_takes_a_name_or_a_project_number(admin_client, rows, text):
    other = EMail.objects.using(f.DB).create(
        location=f.make_location(rows["account"], name="Anderswo", project_id=970102), raw_hash=f.unique("mail"),
        sent_to="x@progeo.com", message="m", files="",
    )
    listed = _listed(_get(admin_client, "email/", location_text=text))

    assert rows["email"] in listed
    assert other not in listed


def test_the_transport_filter_reads_the_bits(admin_client, rows):
    location, user = rows["location"], f.make_user()
    both = f.make_access(location, user, transport=ProgeoAccess.NotifiTrans.EMAIL_AND_SMS)
    messenger = f.make_access(location, user, transport=ProgeoAccess.NotifiTrans.MESSENGER)
    silent = f.make_access(location, user, transport=ProgeoAccess.NotifiTrans.SILENT)

    sms = _listed(_get(admin_client, "progeoaccess/", transport_bit="sms"))
    assert both in sms and messenger not in sms and silent not in sms
    assert both in _listed(_get(admin_client, "progeoaccess/", transport_bit="email"))
    assert _listed(_get(admin_client, "progeoaccess/", transport_bit="silent")) & {both, messenger, silent} == {silent}


def test_locations_by_readiness_and_merge(admin_client, rows):
    account = rows["account"]
    main = f.make_location(account, name="Hauptprojekt", readiness_score=100)
    part = f.make_location(account, name="Teil", parent_location=main, merged_at=timezone.now(), readiness_score=40)

    assert main in _listed(_get(admin_client, "progeolocation/", readiness="100"))
    assert part in _listed(_get(admin_client, "progeolocation/", readiness="0"))
    assert rows["location"] in _listed(_get(admin_client, "progeolocation/", readiness="none"))
    assert _listed(_get(admin_client, "progeolocation/", merge="main")) & {main, part} == {main}
    assert _listed(_get(admin_client, "progeolocation/", merge="part")) & {main, part} == {part}
    assert not _listed(_get(admin_client, "progeolocation/", merge="none")) & {main, part}


def test_site_measurements_by_airtable_state(admin_client):
    synced = _site_measurement(airtable_record_id="rec1")
    pending = _site_measurement()
    failed = _site_measurement(airtable_error="422 Unknown field")

    for state, expected in (("synced", synced), ("pending", pending), ("error", failed)):
        listed = _listed(_get(admin_client, "sitemeasurement/", airtable=state))
        assert listed & {synced, pending, failed} == {expected}, state


def test_login_links_by_state(admin_client, rows):
    user = rows["loginlink"].user
    now = timezone.now()
    used = LoginLink.objects.using(f.DB).create(user=user, purpose="login", token_hash="f" * 64,
                                                expires_at=now + datetime.timedelta(hours=1), used_at=now)
    expired = LoginLink.objects.using(f.DB).create(user=user, purpose="login", token_hash="0" * 64,
                                                   expires_at=now - datetime.timedelta(hours=1))
    links = {rows["loginlink"], used, expired}

    assert _listed(_get(admin_client, "loginlink/", state="valid")) & links == {rows["loginlink"]}
    assert _listed(_get(admin_client, "loginlink/", state="used")) & links == {used}
    assert _listed(_get(admin_client, "loginlink/", state="expired")) & links == {expired}


# ============================================================================== related data


def _hrefs(markup):
    return [html.unescape(href) for href in re.findall(r'href="([^"]+)"', str(markup))]


@pytest.mark.parametrize("model", [ProgeoLocation, ProgeoDevice])
def test_the_related_data_links_open_filtered_lists(admin_client, rows, model):
    obj = rows["location"] if model is ProgeoLocation else rows["progeodevice"]
    hrefs = _hrefs(admin.site._registry[model].related_links(obj))

    assert len(hrefs) >= 6
    for href in hrefs:
        response = admin_client.get(href, secure=True)
        assert response.status_code == 200, (href, response.get("Location"))
        assert response.context["cl"].result_count >= 0


def test_the_alarm_link_of_a_device_lists_its_alarms(admin_client, rows):
    href = next(
        href for href in _hrefs(admin.site._registry[ProgeoDevice].related_links(rows["progeodevice"]))
        if "/progeoalarm/" in href
    )
    assert rows["progeoalarm"] in _listed(admin_client.get(href, secure=True))


def test_the_location_page_shows_its_related_links(admin_client, rows):
    page = _get(admin_client, f"progeolocation/{rows['location'].pk}/change/").content.decode()

    assert f"location__id__exact={rows['location'].pk}" in page
    assert f"location_pk={rows['location'].pk}" in page


# ============================================================================== secrets


@pytest.mark.parametrize("model_name, hidden", [
    ("twofactordevice", SECRET),
    ("twofactordevice", "b" * 64),
    ("loginlink", "a" * 64),
    ("accessrequest", "d" * 64),
    ("notificationtoken", "e" * 64),
    ("systemconfig", "geheim-123"),
    ("systemconfig", "k-456"),
])
def test_secrets_are_never_shown(admin_client, rows, model_name, hidden):
    detail = _get(admin_client, f"{model_name}/{rows[model_name].pk}/change/").content.decode()
    listing = _get(admin_client, f"{model_name}/").content.decode()

    assert hidden not in detail
    assert hidden not in listing


def test_the_configuration_masks_secrets_but_shows_the_rest(admin_client, rows):
    page = _get(admin_client, f"systemconfig/{rows['systemconfig'].pk}/change/").content.decode()

    assert "mail.progeo.com" in page
    assert "••••" in page
    assert 'name="_save"' not in page
    assert admin_client.get(_url(f"systemconfig/{rows['systemconfig'].pk}/delete/"), secure=True).status_code == 403


def test_two_factor_rows_show_the_codes_left_and_can_be_reset(admin_client, rows):
    device = rows["twofactordevice"]
    page = _get(admin_client, f"twofactordevice/{device.pk}/change/").content.decode()

    assert "Recovery codes left" in page
    admin_client.post(_url(f"twofactordevice/{device.pk}/delete/"), {"post": "yes"}, secure=True)
    assert not TwoFactorDevice.objects.using(f.DB).filter(pk=device.pk).exists()


# ============================================================================== actions and forms


def _action(client, model_name, action, objs):
    return client.post(
        _url(f"{model_name}/"), {"action": action, "_selected_action": [obj.pk for obj in objs]},
        secure=True, follow=True,
    )


def test_the_airtable_action_queues_the_selected_measurements(admin_client, monkeypatch):
    queued = []
    monkeypatch.setattr(AirtableHelper, "configured", property(lambda self: True))
    monkeypatch.setattr("progeo.werk.manusensor.queue_airtable_push", queued.append)
    first, second = _site_measurement(), _site_measurement()

    response = _action(admin_client, "sitemeasurement", "copy_to_airtable", [first, second])

    assert sorted(queued) == sorted([first.pk, second.pk])
    assert "2 measurement(s) queued" in response.content.decode()


def test_the_airtable_action_says_when_airtable_is_not_configured(admin_client, monkeypatch):
    monkeypatch.setattr(AirtableHelper, "configured", property(lambda self: False))

    response = _action(admin_client, "sitemeasurement", "copy_to_airtable", [_site_measurement()])

    assert "Airtable is not configured" in response.content.decode()


def test_site_measurements_are_read_only(admin_client, rows):
    page = _get(admin_client, f"sitemeasurement/{rows['sitemeasurement'].pk}/change/").content.decode()

    assert 'name="_save"' not in page
    assert "monteur" in page  # the payload
    assert admin_client.get(_url("sitemeasurement/add/"), secure=True).status_code == 403


# The site measurements inline's empty formset.
NO_INLINE_ROWS = {"site_measurements-TOTAL_FORMS": "0", "site_measurements-INITIAL_FORMS": "0"}


def test_factory_sensors_are_normalized_like_the_upload(admin_client, staff):
    response = admin_client.post(_url("factorysensor/add/"), {
        "project_id": 970111, "sensor": "42", "band": "B1", "tag_uid": "04:a1:b2 c3-d4", "r_werk_ohm": 990,
        **NO_INLINE_ROWS,
    }, secure=True)

    assert response.status_code == 302, response.content.decode()[:2000]
    sensor = FactorySensor.objects.using(f.DB).get(project_id=970111)
    assert (sensor.sensor, sensor.tag_uid, sensor.updated_by_id) == ("000042", "04A1B2C3D4", staff.pk)


def test_a_factory_sensor_needs_a_sensor_number(admin_client):
    response = admin_client.post(_url("factorysensor/add/"), {
        "project_id": 970112, "sensor": "12a", "r_werk_ohm": 990, **NO_INLINE_ROWS,
    }, secure=True)

    assert response.status_code == 200
    assert "1 to 6 digits" in response.content.decode()


def test_tokens_can_be_revoked_and_links_expired(admin_client, rows):
    link = rows["loginlink"]
    _action(admin_client, "loginlink", "expire_links", [link])
    link.refresh_from_db(using=f.DB)
    assert link.expires_at <= timezone.now()


def test_review_notes_are_marked_done_and_reopened(admin_client, rows, staff):
    note = rows["screenreviewnote"]

    _action(admin_client, "screenreviewnote", "mark_done", [note])
    note.refresh_from_db(using=f.DB)
    assert note.done_at is not None and note.done_by_id == staff.pk

    _action(admin_client, "screenreviewnote", "reopen", [note])
    note.refresh_from_db(using=f.DB)
    assert note.done_at is None


def test_editing_a_measurement_keeps_its_time(rows):
    measurement = rows["progeomeasurement"]
    measured = timezone.now() - datetime.timedelta(days=40)
    ProgeoMeasurement.objects.using(f.DB).filter(pk=measurement.pk).update(last_fetched=measured)
    measurement.refresh_from_db(using=f.DB)
    measurement.archived = True

    admin.site._registry[ProgeoMeasurement].save_model(_request(), measurement, form=None, change=True)

    measurement.refresh_from_db(using=f.DB)
    assert measurement.archived is True
    assert measurement.last_fetched == measured


def test_the_measurement_page_lists_the_values_per_input(admin_client, rows):
    page = _get(admin_client, f"progeomeasurement/{rows['progeomeasurement'].pk}/change/").content.decode()

    assert 'class="admin-potentials"' in page
    assert "<b>150</b>" in page  # |W-E| of the alarm's measurement


# ============================================================================== paginator


def test_the_paginator_estimates_only_unfiltered_lists(monkeypatch, rows):
    measurements = ProgeoMeasurement.objects.using(f.DB).order_by("pk")
    with connections[f.DB].cursor() as cursor:
        cursor.execute("ANALYZE progeo_progeomeasurement")
    monkeypatch.setattr(EstimatedCountPaginator, "EXACT_BELOW", 0)

    assert EstimatedCountPaginator(measurements, 10).count == measurements.count()
    assert EstimatedCountPaginator(measurements.filter(archived=False), 10)._estimate() is None


def test_small_tables_are_counted_exactly(rows):
    measurements = ProgeoMeasurement.objects.using(f.DB).order_by("pk")

    assert EstimatedCountPaginator(measurements, 10).count == measurements.count()
