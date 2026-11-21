"""The button permissions (helper/button_permissions.py): merging locations,
the admin panel's sections and the user actions - without them the backend
refuses, staff included (decorator.holds_permission); only superusers pass.
grant_button_permissions gave them to everyone who could act before."""

import pytest
from django.contrib.admin.sites import AdminSite
from django.contrib.auth.models import User
from django.test import RequestFactory

from progeo.helper.button_permissions import implied_permissions
from progeo.tests import factories as f
from progeo.tests.mailfakes import fake_smtp  # noqa: F401
from progeo.v1.admin import ProgeoLocationAdmin
from progeo.v1.models import ProgeoAccess, ProgeoLocation

pytestmark = pytest.mark.usefixtures("fake_smtp")

USERS = "/api/auth-support/staff/users/"
NOTIF = ("module_notifications_enabled", "module_notifications_add", "module_notifications_edit")
CUSTOMER_ADMIN = ("module_locations_enabled", "module_locations_edit", *NOTIF)


def _staff_without(*codes):
    """A staff member holding every button permission but `codes`."""
    held = ["module_admin_staff_enabled"]
    held.extend(code for code in implied_permissions((), staff=True) if code not in codes)
    return f.make_user(staff=True, perms=held, implied=False, email=f"{f.unique('staff')}@progeo.com")


def _codes(user):
    return set(User.objects.using(f.DB).get(pk=user.pk).user_permissions.values_list("codename", flat=True))


# ---------------------------------------------------------------------------- /staff/ user actions

def test_creating_a_user_needs_module_user_add(api_client):
    api_client.force_authenticate(user=_staff_without("module_user_add"))

    response = api_client.post(USERS, {"username": f.unique("neu"), "email": "neu@progeo.com"}, format="json")

    assert response.status_code == 403 and response.json()["missing_permissions"] == ["module_user_add"]


def test_creating_with_an_invitation_needs_module_user_invitable(api_client):
    api_client.force_authenticate(user=_staff_without("module_user_invitable"))

    response = api_client.post(USERS, {"username": f.unique("neu"), "email": "neu@progeo.com", "send_invite": True},
                               format="json")

    assert response.json()["missing_permissions"] == ["module_user_invitable"]


def test_inviting_needs_module_user_invitable(api_client):
    target = f.make_user(email=f"{f.unique('t')}@progeo.com")
    api_client.force_authenticate(user=_staff_without("module_user_invitable"))

    assert api_client.post(f"{USERS}{target.pk}/invite/").status_code == 403


def test_deactivating_needs_module_user_disability_but_other_edits_do_not(api_client):
    target = f.make_user(email=f"{f.unique('t')}@progeo.com")
    api_client.force_authenticate(user=_staff_without("module_user_disability"))

    refused = api_client.post(f"{USERS}{target.pk}/update/", {"is_active": False}, format="json")
    # The form sends the unchanged flag along - that is no deactivation.
    kept = api_client.post(f"{USERS}{target.pk}/update/", {"is_active": True, "email": "x@progeo.com"},
                           format="json")

    assert refused.json()["missing_permissions"] == ["module_user_disability"]
    assert kept.status_code == 200, kept.content
    assert User.objects.using(f.DB).get(pk=target.pk).is_active


def test_deleting_needs_module_user_erasability(api_client):
    target = f.make_user()
    api_client.force_authenticate(user=_staff_without("module_user_erasability"))

    assert api_client.post(f"{USERS}{target.pk}/delete/").status_code == 403
    assert User.objects.using(f.DB).filter(pk=target.pk).exists()


def test_superusers_need_none_of_them(api_client):
    target = f.make_user()
    api_client.force_authenticate(user=f.make_user(is_superuser=True, implied=False))

    assert api_client.post(f"{USERS}{target.pk}/delete/").json()["success"] is True


# ---------------------------------------------------------------------------- Rechte tab

def test_the_rechte_tab_needs_invitable_and_revokable(api_client):
    account = f.make_account()
    location = f.make_location(account)
    admin = f.make_user(perms=CUSTOMER_ADMIN, accounts=[account], implied=False)
    rule = f.make_access(location, f.make_user())
    api_client.force_authenticate(user=admin)

    access = api_client.get(f"/v1/location/{location.pk}/access/").json()
    invite = api_client.post(f"/v1/location/{location.pk}/access/invite/", {"email": "neu@progeo.com"},
                             format="json")
    revoke = api_client.post(f"/v1/location/{location.pk}/access/delete/", {"id": rule.pk}, format="json")

    assert (access["can_invite"], access["can_revoke"]) == (False, False)
    assert invite.json()["missing_permissions"] == ["module_user_invitable"]
    assert revoke.json()["missing_permissions"] == ["module_user_revokable"]
    assert ProgeoAccess.objects.using(f.DB).filter(pk=rule.pk).exists()


# ---------------------------------------------------------------------------- merging, admin panel

def test_merging_needs_module_locations_mergable(api_client):
    account = f.make_account()
    halls = [f.make_location(account, project_id=94000 + index) for index in range(2)]
    perms = ("module_locations_enabled", "module_locations_edit", "module_locations_selectable")
    api_client.force_authenticate(user=f.make_user(perms=perms, accounts=[account], implied=False))

    response = api_client.post("/v1/location-selection/merge/",
                               {"ids": [hall.pk for hall in halls], "project_id": 94999}, format="json")

    assert response.json()["missing_permissions"] == ["module_locations_mergable"]


@pytest.mark.parametrize(("url", "code"), [
    ("/v1/status/admin/storage_info/", "module_admin_storage"),
    ("/v1/status/admin/log_files/", "module_admin_logs"),
    ("/v1/status/admin/lageplan_export/?days=1", "module_admin_lageplan_export"),
])
def test_each_admin_panel_section_needs_its_permission(api_client, url, code):
    others = [other for other in ("module_admin_storage", "module_admin_logs", "module_admin_lageplan_export")
              if other != code]
    api_client.force_authenticate(user=f.make_user(
        staff=True,
        perms=("module_admin_enabled", "module_admin_panel", *others),
        implied=False,
    ))

    response = api_client.get(url)

    assert response.status_code == 403 and response.json()["missing_permissions"] == [code]


def test_admin_panel_requires_its_staff_permission(api_client):
    api_client.force_authenticate(user=f.make_user(staff=True, perms=("module_admin_storage",), implied=False))

    response = api_client.get("/v1/status/admin/storage_info/")

    assert response.status_code == 403
    assert response.json()["missing_permissions"] == ["module_admin_panel"]


@pytest.mark.parametrize(
    ("permission", "change", "delete"),
    [
        ("module_locations_django_edit", True, False),
        ("module_locations_django_delete", False, True),
    ],
)
def test_location_django_admin_uses_the_action_permissions(permission, change, delete):
    user = f.make_user(staff=True, perms=(permission,))
    request = RequestFactory().get("/")
    request.user = user
    model_admin = ProgeoLocationAdmin(ProgeoLocation, AdminSite())

    assert model_admin.has_change_permission(request) is change
    assert model_admin.has_delete_permission(request) is delete
