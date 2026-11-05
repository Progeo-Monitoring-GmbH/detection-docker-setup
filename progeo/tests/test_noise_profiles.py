"""Störungsprofile (helper/noise_profiles.py, ProgeoNoiseProfile, the
location/<pk>/noise-profiles/ routes): masks cleaning EP / WP everywhere."""
import csv
import io
from datetime import timedelta

import pytest
from django.utils import timezone

from progeo.helper import noise_profiles
from progeo.helper.noise_profiles import NoiseMask
from progeo.tests import factories as f
from progeo.v1.models import Account, ProgeoMeasurement, ProgeoNoiseProfile

PERMS = ("module_locations_enabled", "module_measurements_enabled")


@pytest.fixture(autouse=True)
def _fresh_masks():
    noise_profiles.clear_local_cache()
    yield
    noise_profiles.clear_local_cache()


def _profile(device, mask_e, mask_w, active=False, name="Grundrauschen"):
    profile = ProgeoNoiseProfile(device=device, name=name, mask_e=mask_e, mask_w=mask_w)
    profile.save(using=f.DB)
    if active:
        noise_profiles.activate(profile, f.DB)
    return profile


def _world(account):
    location = f.make_location(account, project_id=4711)
    device = f.make_device(location)
    user = f.make_user(perms=PERMS, accounts=[account])
    staff = f.make_user(staff=True, perms=PERMS, accounts=[account])
    return {"account": account, "location": location, "device": device, "user": user, "staff": staff}


@pytest.fixture
def world():
    # The request account (AccountMiddleware) - staff see its locations.
    return _world(Account.objects.using(f.DB).get(pk=1))


@pytest.fixture
def user_world():
    # Users see the locations of their own account.
    return _world(f.make_account())


def _url(world, path=""):
    return f"/v1/location/{world['location'].id}/{path}"


# -- the mask (no database) -------------------------------------------------------

def test_mask_subtracts_per_value_and_clamps_at_zero():
    mask = NoiseMask([3, 10], [5, 2])

    # [EP1, WP1, EP2, WP2]
    assert mask.apply([10, 4, 12, 9]) == [7, 0, 2, 7]


def test_sensors_past_the_mask_stay_as_they_are():
    mask = NoiseMask([1], [1])

    assert mask.apply([5, 6, 7, 8]) == [4, 5, 7, 8]


def test_masks_of_different_length_are_padded_with_zero():
    assert NoiseMask([1, 2], [3]).interleaved == (1, 3, 2, 0)


def test_mask_values_are_checked():
    assert noise_profiles.clean_mask([1, 2.6, "3"], "mask_e") == [1, 3, 3]
    for bad in ("1,2", [1, "x"], [float("inf")], [2**40]):
        with pytest.raises((TypeError, ValueError)):
            noise_profiles.clean_mask(bad, "mask_e")


# -- reads use the active profile -------------------------------------------------

def test_active_profile_cleans_pairs_and_evaluation(world):
    device = world["device"]
    measurement = f.make_measurement(device, eigenpotenzial=[100, 50], wirkpotenzial=[400, 60])
    assert measurement.get_pairs() == [300, 10]

    _profile(device, [100, 40], [150, 60], active=True)
    measurement = ProgeoMeasurement.objects.using(f.DB).get(pk=measurement.pk)

    # EP' = [0, 10], WP' = [250, 0]
    assert measurement.get_sample_values() == [0, 250, 10, 0]
    assert measurement.get_pairs() == [250, 10]
    assert measurement.get_pairs(raw=True) == [300, 10]
    assert measurement.evaluate_all(260) == []
    assert measurement.evaluate_all(200) == [(0, 250)]


def test_inactive_profiles_change_nothing(world):
    device = world["device"]
    measurement = f.make_measurement(device, eigenpotenzial=[100], wirkpotenzial=[400])
    _profile(device, [100], [150])

    assert ProgeoMeasurement.objects.using(f.DB).get(pk=measurement.pk).get_pairs() == [300]


def test_only_the_last_activated_profile_is_active(world):
    device = world["device"]
    first = _profile(device, [10], [10], active=True, name="erstes")
    second = _profile(device, [20], [20], active=True, name="zweites")

    first.refresh_from_db(using=f.DB)
    second.refresh_from_db(using=f.DB)
    assert (first.is_active, second.is_active) == (False, True)
    assert noise_profiles.active_mask(f.DB, device.pk).profile_id == second.pk


def test_a_change_is_seen_at_once_in_this_process(world):
    device = world["device"]
    profile = _profile(device, [10], [10])
    assert noise_profiles.active_mask(f.DB, device.pk) is None  # cached: none

    noise_profiles.activate(profile, f.DB)
    assert noise_profiles.active_mask(f.DB, device.pk).profile_id == profile.pk

    noise_profiles.deactivate(device.pk, f.DB)
    assert noise_profiles.active_mask(f.DB, device.pk) is None


def test_another_process_reloads_after_the_shared_version_changed(world, monkeypatch):
    device = world["device"]
    profile = _profile(device, [10], [10])
    assert noise_profiles.active_mask(f.DB, device.pk) is None
    # Another process activates: the row changes and the shared version.
    ProgeoNoiseProfile.objects.using(f.DB).filter(pk=profile.pk).update(is_active=True)
    shared = {"version": "other-process"}
    monkeypatch.setattr(noise_profiles, "cache_get", lambda key, default=None: shared["version"])
    noise_profiles._version["checked_at"] = float("-inf")  # the check interval has passed

    assert noise_profiles.active_mask(f.DB, device.pk).profile_id == profile.pk


def test_noise_view_reads_raw_or_a_chosen_mask(world):
    device = world["device"]
    measurement = f.make_measurement(device, eigenpotenzial=[100], wirkpotenzial=[400])
    _profile(device, [100], [150], active=True)
    measurement = ProgeoMeasurement.objects.using(f.DB).get(pk=measurement.pk)

    with noise_profiles.noise_view(raw=True):
        assert measurement.get_pairs() == [300]
    with noise_profiles.noise_view(masks={device.pk: NoiseMask([0], [200])}):
        assert measurement.get_pairs() == [100]
    assert measurement.get_pairs() == [250]


def test_sums_are_kept_with_the_masks(world):
    profile = _profile(world["device"], [1, 2, 3], [10, 20])
    assert (profile.sum_e, profile.sum_w) == (6, 30)

    profile.mask_e = [5]
    profile.save(using=f.DB, update_fields=["mask_e"])
    profile.refresh_from_db(using=f.DB)
    assert profile.sum_e == 5


# -- endpoints --------------------------------------------------------------------

def test_profiles_are_staff_only(api_client, world):
    api_client.force_authenticate(world["user"])

    for method, path in (
        ("get", "noise-profiles/"),
        ("get", f"noise-profiles/suggest/?device={world['device'].pk}&days=7"),
        ("post", "noise-profiles/save/"),
        ("post", "noise-profiles/activate/"),
        ("post", "noise-profiles/deactivate/"),
        ("post", "noise-profiles/delete/"),
    ):
        body = getattr(api_client, method)(_url(world, path), format="json").json()
        assert body["success"] is False, path
        assert body["reason"] == "Staff access required", path


def test_suggestion_is_the_minimum_of_every_measurement_of_the_period(api_client, world):
    device = world["device"]
    now = timezone.now()
    # More measurements than the Analyse tab loads would still all count.
    f.make_measurement(device, eigenpotenzial=[50, 9], wirkpotenzial=[70, 30], fetched_at=now - timedelta(hours=1))
    f.make_measurement(device, eigenpotenzial=[40, 12, 5], wirkpotenzial=[80, 20, 6], fetched_at=now - timedelta(hours=2))
    f.make_measurement(device, eigenpotenzial=[1], wirkpotenzial=[1], fetched_at=now - timedelta(days=20))  # outside
    f.make_measurement(device, fetched_at=now - timedelta(hours=3))  # no potentials
    _profile(device, [1000], [1000], active=True)  # the suggestion is raw
    api_client.force_authenticate(world["staff"])

    body = api_client.get(_url(world, "noise-profiles/suggest/"), {"device": device.pk, "days": 7}).json()

    assert body["success"] is True, body
    assert (body["mask_e"], body["mask_w"]) == ([40, 9, 5], [70, 20, 6])
    assert (body["sum_e"], body["sum_w"], body["source_count"]) == (54, 96, 2)


def test_suggestion_needs_a_device_of_the_location(api_client, world):
    other = f.make_device(f.make_location(world["account"]))
    api_client.force_authenticate(world["staff"])

    body = api_client.get(_url(world, "noise-profiles/suggest/"), {"device": other.pk, "days": 7}).json()

    assert body == {"success": False, "reason": "Device not found"}


def test_save_activate_deactivate_and_delete(api_client, world):
    device = world["device"]
    api_client.force_authenticate(world["staff"])

    created = api_client.post(_url(world, "noise-profiles/save/"), {
        "device": device.pk, "name": "Pumpe", "mask_e": [1, 2], "mask_w": [3, 4],
        "source_from": "2026-11-01T00:00:00Z", "source_count": 12,
    }, format="json").json()
    assert created["success"] is True, created
    profile = created["profile"]
    assert (profile["is_active"], profile["sum_e"], profile["sum_w"], profile["source_count"]) == (False, 3, 7, 12)

    edited = api_client.post(_url(world, "noise-profiles/save/"), {
        "id": profile["id"], "name": "Pumpe (Hand)", "mask_e": [5, 2], "mask_w": [3, 4],
    }, format="json").json()
    assert (edited["profile"]["name"], edited["profile"]["mask_e"]) == ("Pumpe (Hand)", [5, 2])

    activated = api_client.post(_url(world, "noise-profiles/activate/"), {"id": profile["id"]}, format="json").json()
    assert activated["profile"]["is_active"] is True
    assert noise_profiles.active_mask(f.DB, device.pk).interleaved == (5, 3, 2, 4)

    listed = api_client.get(_url(world, "noise-profiles/")).json()
    assert [(entry["id"], entry["is_active"]) for entry in listed["profiles"]] == [(profile["id"], True)]

    deactivated = api_client.post(_url(world, "noise-profiles/deactivate/"), {"device": device.pk}, format="json").json()
    assert deactivated["deactivated"] == 1
    assert noise_profiles.active_mask(f.DB, device.pk) is None

    deleted = api_client.post(_url(world, "noise-profiles/delete/"), {"id": profile["id"]}, format="json").json()
    assert deleted == {"success": True, "deleted": profile["id"]}
    assert not ProgeoNoiseProfile.objects.using(f.DB).filter(pk=profile["id"]).exists()


def test_save_refuses_bad_masks(api_client, world):
    api_client.force_authenticate(world["staff"])

    body = api_client.post(_url(world, "noise-profiles/save/"), {
        "device": world["device"].pk, "name": "x", "mask_e": "1,2", "mask_w": [],
    }, format="json").json()

    assert body == {"success": False, "reason": "mask_e must be a list"}


def test_profiles_of_other_locations_are_not_found(api_client, world):
    other_device = f.make_device(f.make_location(world["account"]))
    foreign = _profile(other_device, [1], [1])
    api_client.force_authenticate(world["staff"])

    body = api_client.post(_url(world, "noise-profiles/activate/"), {"id": foreign.pk}, format="json").json()

    assert body == {"success": False, "reason": "Noise profile not found"}


# -- displays ---------------------------------------------------------------------

def _cleaned(world):
    """A measurement |400 - 100| = 300, cleaned by the active profile to 250."""
    device = world["device"]
    f.make_measurement(device, eigenpotenzial=[100], wirkpotenzial=[400])
    world["profile"] = _profile(device, [100], [150], active=True)
    world["other"] = _profile(device, [0], [200], name="Test")  # |100 - 200| = 100
    return world


@pytest.fixture
def cleaned(world):
    return _cleaned(world)


@pytest.fixture
def user_cleaned(user_world):
    return _cleaned(user_world)


def test_heatmap_and_measurements_are_cleaned_for_everyone(api_client, user_cleaned):
    cleaned = user_cleaned
    api_client.force_authenticate(cleaned["user"])

    heatmap = api_client.get(_url(cleaned, "heatmap/?limit=10")).json()
    rows = api_client.get(_url(cleaned, "measurements/?limit=10")).json()["measurements"]

    assert heatmap["data"] == {"1": [250]}
    assert [(row["samples"], row["pair_abs_values"]) for row in rows] == [([0, 250], [250])]


def test_users_cannot_ask_for_raw_values(api_client, user_cleaned):
    cleaned = user_cleaned
    api_client.force_authenticate(cleaned["user"])

    heatmap = api_client.get(_url(cleaned, f"heatmap/?limit=10&raw=1&noise_profile={cleaned['other'].pk}")).json()

    assert heatmap["data"] == {"1": [250]}


def test_staff_read_raw_values_or_test_a_profile(api_client, cleaned):
    api_client.force_authenticate(cleaned["staff"])

    raw = api_client.get(_url(cleaned, "heatmap/?limit=10&raw=1")).json()
    tested = api_client.get(_url(cleaned, f"heatmap/?limit=10&noise_profile={cleaned['other'].pk}")).json()
    raw_rows = api_client.get(_url(cleaned, "measurements/?limit=10&raw=1")).json()["measurements"]

    assert raw["data"] == {"1": [300]}
    assert tested["data"] == {"1": [100]}
    assert raw_rows[0]["pair_abs_values"] == [300]
    # The test changes nothing for anyone else.
    assert api_client.get(_url(cleaned, "heatmap/?limit=10")).json()["data"] == {"1": [250]}


def test_staff_download_the_raw_csv(api_client, cleaned):
    api_client.force_authenticate(cleaned["staff"])

    def values(query):
        response = api_client.get(_url(cleaned, f"export_csv/{query}"))
        return response["Content-Disposition"], list(csv.reader(io.StringIO(response.content.decode())))[1][1:]

    assert values("") == (f'attachment; filename="{cleaned["location"].project_id}-messwerte.csv"', ["250"])
    assert values("?raw=1") == (f'attachment; filename="{cleaned["location"].project_id}-messwerte-roh.csv"', ["300"])
