"""Shared helpers for tests that act as a provisioned device (plain module, no fixtures)."""
import itertools

from progeo.tests import factories as f
from progeo.v1.models import Account

project_ids = itertools.count(961001)


def provision_device(client, model, **location_fields):
    """Provision a device of `model` at a new location as staff; returns (location, preview)."""
    location = f.make_location(Account.objects.using(f.DB).get(pk=1), project_id=next(project_ids), **location_fields)
    client.force_authenticate(user=f.make_user(staff=True))
    preview = client.post(
        "/v1/device/provision/preview/", {"location": location.pk, "model": model}, format="json"
    ).json()
    client.post("/v1/device/provision/confirm/", {"signed": preview["signed"]}, format="json")
    return location, preview


def as_controller(client, preview):
    client.force_authenticate(user=None)
    client.credentials(HTTP_AUTHORIZATION=f"Token {preview['token']}")
