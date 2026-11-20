"""Screen review (helper/screen_review.py, /v1/screen-review/): the runs of
the e2e_screenshots command, their images, the review notes and the ZIP
export with the commented screenshots and PROMPT.md."""
import io
import json
import re
import zipfile

import pytest
from PIL import Image

from progeo.helper import screen_review as review
from progeo.tests import factories as f
from progeo.v1.models import ScreenReviewNote

RUN = "2026-11-18_235532"
URL = f"/v1/screen-review/{RUN}/"


@pytest.fixture
def uploads(settings, tmp_path):
    settings.UPLOAD_DIR = str(tmp_path / "uploads")
    return tmp_path / "uploads"


def _png(path, size, color=(240, 240, 240)):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color).save(path)


@pytest.fixture
def run(uploads):
    folder = uploads / "e2e" / RUN
    _png(folder / "pc" / "pc-staff-en-location-overview.png", (1440, 2600))
    _png(folder / "mobile" / "mobile-user-login.png", (390, 900))
    _png(folder / "pc" / "pc-staff-en-staff-admin--staff-user-edit-dialog.png", (1440, 900))
    # Not a screenshot of the run: left out.
    _png(folder / "pc" / "notes.png", (10, 10))
    (folder / "manifest.json").write_text(json.dumps({"run": RUN, "images": [
        {"file": "pc-staff-en-location-overview.png", "path": "/location/overview/", "viewport": [1440, 900],
         "width": 1, "height": 1, "errors": ["TypeError: x is undefined"]},
        {"file": "pc-staff-en-staff-admin--staff-user-edit-dialog.png", "path": "/staff/",
         "url": "/staff/?tab=users", "viewport": [1440, 900], "errors": [],
         "modal": {"name": "staff-user-edit-dialog", "testId": "staff-user-edit-dialog", "path": "/staff/",
                   "scenario": None, "steps": [
                       {"do": "click", "css": '#row-2 [data-testid^="expander-button-"]', "device": "mobile"},
                       {"do": "click", "testId": "staff-user-edit", "key": "2"},
                       {"do": "teleport", "testId": "nowhere"},
                   ]}},
    ], "failures": [
        {"file": "pc-staff-en-staff-admin--staff-user-delete-dialog.png", "url": "/staff/",
         "modal": {"name": "staff-user-delete-dialog", "testId": "staff-user-delete-dialog",
                   "steps": [{"do": "click", "testId": "staff-user-delete", "key": "2"}]},
         "reason": "step 1 (click staff-user-delete): Timeout 8000ms exceeded."},
        {"file": "../../etc/passwd", "reason": "not a screenshot"},
    ]}), encoding="utf-8")
    return folder


@pytest.fixture
def staff(api_client):
    user = f.make_user(
        staff=True,
        first_name="Jonas",
        last_name="Weber",
        perms=("module_admin_screen_review",),
    )
    api_client.force_authenticate(user=user)
    return user


def test_a_new_run_gets_its_dated_folder_with_pc_and_mobile(uploads):
    folder = review.new_run_dir()

    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}_\d{6}", folder.name)
    assert folder.parent == (uploads / "e2e").resolve()
    assert {child.name for child in folder.iterdir()} == {"pc", "mobile"}


@pytest.mark.parametrize("name, parsed", [
    ("pc-staff-en-location-overview.png", ("pc", "staff", "en", "location-overview", None)),
    ("mobile-user-login.png", ("mobile", "user", "de", "login", None)),
    ("pc-user-de-location-overview--user-profile.png", ("pc", "user", "de", "location-overview", "user-profile")),
    ("mobile-staff-en-staff-admin--staff-user-reset-two-factor-dialog.png",
     ("mobile", "staff", "en", "staff-admin", "staff-user-reset-two-factor-dialog")),
    ("pc-user-de-login--.png", None),
    ("pc-user-de---x.png", None),
])
def test_file_names_name_the_page_and_its_dialog(name, parsed):
    assert review.parse_image_name(name) == parsed


def test_the_images_of_a_run_come_from_its_folders_and_manifest(run):
    images = {image["file"]: image for image in review.run_images(RUN)}

    assert set(images) == {"pc-staff-en-location-overview.png", "mobile-user-login.png",
                           "pc-staff-en-staff-admin--staff-user-edit-dialog.png"}
    overview = images["pc-staff-en-location-overview.png"]
    assert (overview["device"], overview["role"], overview["language"], overview["action"]) == (
        "pc", "staff", "en", "location-overview")
    assert overview["path"] == "/location/overview/"
    # The size is the image's own, not the manifest's.
    assert (overview["width"], overview["height"]) == (1440, 2600)
    assert overview["errors"] == ["TypeError: x is undefined"]
    assert images["mobile-user-login.png"]["viewport"] is None
    # A run from before the languages: German.
    assert images["mobile-user-login.png"]["language"] == "de"
    # Runs before the dialogs: the route's path is the URL, no dialog.
    assert (overview["url"], overview["modal"]) == ("/location/overview/", None)
    assert (images["mobile-user-login.png"]["url"], images["mobile-user-login.png"]["modal"]) == (None, None)


def test_a_dialog_screenshot_knows_its_page_url_and_how_it_opens(run):
    images = {image["file"]: image for image in review.run_images(RUN)}

    dialog = images["pc-staff-en-staff-admin--staff-user-edit-dialog.png"]
    assert (dialog["action"], dialog["path"], dialog["url"]) == ("staff-admin", "/staff/", "/staff/?tab=users")
    assert dialog["modal"] == {
        "name": "staff-user-edit-dialog", "testId": "staff-user-edit-dialog", "path": "/staff/", "scenario": None,
        # Unknown steps are left out.
        "steps": [
            {"do": "click", "css": '#row-2 [data-testid^="expander-button-"]', "device": "mobile"},
            {"do": "click", "testId": "staff-user-edit", "key": "2"},
        ],
    }
    assert [review.step_text(step) for step in dialog["modal"]["steps"]] == [
        'click #row-2 [data-testid^="expander-button-"] (on mobile only)',
        'click [data-testid="staff-user-edit"][data-test-key="2"]',
    ]


@pytest.mark.parametrize("step, text", [
    ({"do": "click", "testId": "measurement-compare-columns-plot", "position": {"x": 12, "y": 120}},
     'click [data-testid="measurement-compare-columns-plot"] at (12, 120)'),
    ({"do": "select", "testId": "noise-profile-select", "value": "5"},
     'select [data-testid="noise-profile-select"] = "5"'),
    ({"do": "upload", "testId": "anlegen-import-input", "file": {"name": "standort.json", "content": "{}"}},
     'upload [data-testid="anlegen-import-input"] (standort.json)'),
    ({"do": "wait", "ms": 500}, "wait 500 ms"),
    # Not a number: no position.
    ({"do": "click", "testId": "plot", "position": {"x": "12", "y": 1}}, 'click [data-testid="plot"]'),
])
def test_the_steps_read_as_text(step, text):
    assert review.step_text(review._clean_step(step)) == text


def test_a_dialog_without_manifest_entry_still_has_its_name(run):
    _png(run / "pc" / "pc-user-de-login--privacy-settings.png", (1440, 900))

    images = {image["file"]: image for image in review.run_images(RUN)}

    assert images["pc-user-de-login--privacy-settings.png"]["modal"] == {
        "name": "privacy-settings", "testId": None, "path": None, "scenario": None, "steps": []}


def test_the_dialogs_that_did_not_open_are_listed_with_their_reason(run):
    failures = review.run_failures(RUN)

    assert [(entry["action"], entry["modal"]["name"], entry["url"]) for entry in failures] == [
        ("staff-admin", "staff-user-delete-dialog", "/staff/")]
    assert "Timeout 8000ms" in failures[0]["reason"]


def test_a_run_without_failures_in_its_manifest_has_none(run):
    (run / "manifest.json").write_text(json.dumps({"run": RUN, "images": []}), encoding="utf-8")

    assert review.run_failures(RUN) == []


@pytest.mark.parametrize("run_name, image", [
    ("../2026-11-18_235532", "pc-staff-en-location-overview.png"),
    (RUN, "../../secret.png"),
    (RUN, "pc-staff-missing.png"),
    (RUN, "notes.png"),
])
def test_only_screenshots_of_a_run_are_served(run, run_name, image):
    with pytest.raises(review.ReviewError):
        review.image_path(run_name, image)


def test_staff_list_the_runs_and_see_a_run(api_client, run, staff):
    runs = api_client.get("/v1/screen-review/").json()["runs"]
    assert runs == [{"run": RUN, "created": runs[0]["created"], "images": 3, "notes": 0}]

    body = api_client.get(URL).json()
    assert {image["file"] for image in body["images"]} == {
        "pc-staff-en-location-overview.png", "mobile-user-login.png",
        "pc-staff-en-staff-admin--staff-user-edit-dialog.png"}
    assert body["notes"] == []
    assert [entry["file"] for entry in body["failures"]] == ["pc-staff-en-staff-admin--staff-user-delete-dialog.png"]
    assert api_client.get(f"{URL}image/pc-staff-en-staff-admin--staff-user-edit-dialog.png/").status_code == 200

    image = api_client.get(f"{URL}image/mobile-user-login.png/")
    assert image.status_code == 200
    assert image["Content-Type"] == "image/png"
    assert api_client.get(f"{URL}image/pc-staff-nothing.png/").status_code == 404


def test_customers_see_no_screens(api_client, run):
    api_client.force_authenticate(user=f.make_user(perms=("module_locations_enabled",)))

    assert api_client.get("/v1/screen-review/").status_code == 403
    assert api_client.get(f"{URL}image/mobile-user-login.png/").status_code == 403


def test_staff_without_screen_review_permission_is_denied(api_client, run):
    api_client.force_authenticate(user=f.make_user(staff=True))

    assert api_client.get("/v1/screen-review/").status_code == 403


def _note(api_client, **fields):
    data = {"image": "pc-staff-en-location-overview.png", "kind": "arrow", "action": "move", "comment": "Nach rechts",
            "geometry": {"x1": 100, "y1": 300, "x2": 900, "y2": 320}, **fields}
    return api_client.post(f"{URL}notes/", data, format="json")


def test_notes_are_made_changed_and_deleted(api_client, run, staff):
    created = _note(api_client).json()["note"]
    assert (created["kind"], created["action"], created["author_name"]) == ("arrow", "move", "Jonas Weber")
    assert created["geometry"] == {"x1": 100.0, "y1": 300.0, "x2": 900.0, "y2": 320.0}

    changed = api_client.patch(f"{URL}notes/{created['id']}/", {"action": "remove", "comment": "Weg damit"},
                               format="json").json()["note"]
    assert (changed["action"], changed["comment"], changed["geometry"]) == ("remove", "Weg damit", created["geometry"])

    assert api_client.delete(f"{URL}notes/{created['id']}/").status_code == 200
    assert not ScreenReviewNote.objects.exists()


@pytest.mark.parametrize("fields", [
    {"image": "pc-staff-missing.png"},
    {"kind": "circle"},
    {"action": "paint"},
    {"geometry": {"x1": 1, "y1": 2, "x2": "3", "y2": 4}},
    {"kind": "area", "geometry": {"x": 1, "y": 2, "w": 0, "h": 4}},
    {"comment": "x" * 5001},
])
def test_invalid_notes_are_refused(api_client, run, staff, fields):
    assert _note(api_client, **fields).status_code == 400
    assert not ScreenReviewNote.objects.exists()


def test_the_export_holds_the_commented_screens_and_the_prompt(api_client, run, staff):
    _note(api_client)
    _note(api_client, kind="area", action="bigger", comment="Tabelle zu klein",
          geometry={"x": 40, "y": 1200, "w": 600, "h": 300})
    _note(api_client, image="mobile-user-login.png", kind="note", action="select", comment="Logo fehlt", geometry=None)

    response = api_client.get(f"{URL}export/")

    assert response.status_code == 200
    assert response["Content-Type"] == "application/zip"
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    assert set(archive.namelist()) == {
        "PROMPT.md", "notes.json", "screens/pc-staff-en-location-overview.png", "screens/mobile-user-login.png",
    }
    prompt = archive.read("PROMPT.md").decode("utf-8")
    assert f"# Screen review – build {RUN}" in prompt
    assert "3 comment(s) on 2 screen(s): 1 × bigger, 1 × move, 1 × select." in prompt
    assert "Route: `/location/overview/`" in prompt
    assert "language: en" in prompt
    assert "1. **MOVE** – arrow from (100, 300) to (900, 320): Nach rechts" in prompt
    assert "2. **BIGGER** – area x 40–640, y 1200–1500: Tabelle zu klein" in prompt
    assert "1. **SELECT** – the whole screen: Logo fehlt" in prompt
    assert "TypeError: x is undefined" in prompt
    assert "- URL: `/location/overview/`" in prompt
    # The arrow is drawn in: the plain grey screenshot has its colour now.
    drawn = Image.open(io.BytesIO(archive.read("screens/pc-staff-en-location-overview.png"))).convert("RGB")
    assert drawn.size == (1440, 2600)
    assert drawn.getpixel((500, 310)) == review.ACTION_COLOR["move"]
    assert len(json.loads(archive.read("notes.json"))["notes"]) == 3


def test_the_export_names_a_dialog_its_url_and_how_it_opens(api_client, run, staff):
    _note(api_client, image="pc-staff-en-staff-admin--staff-user-edit-dialog.png", kind="note", action="remove",
          comment="Feld weg", geometry=None)
    _note(api_client, kind="note", action="select", comment="Seite", geometry=None)

    archive = zipfile.ZipFile(io.BytesIO(api_client.get(f"{URL}export/").content))
    prompt = archive.read("PROMPT.md").decode("utf-8")

    section = prompt.split("## pc-staff-en-staff-admin--staff-user-edit-dialog.png")[1]
    assert "- URL: `/staff/?tab=users`" in section
    assert '- Dialog: **staff-user-edit-dialog** (`[data-testid="staff-user-edit-dialog"]`)' in section
    assert ('- Opened by: `click #row-2 [data-testid^="expander-button-"] (on mobile only)` → '
            '`click [data-testid="staff-user-edit"][data-test-key="2"]`') in section
    assert "screens/pc-staff-en-staff-admin--staff-user-edit-dialog.png" in archive.namelist()
    # The page comes before its dialogs.
    assert prompt.index("## pc-staff-en-location-overview.png") < prompt.index("## pc-staff-en-staff-admin--")


def test_superusers_delete_a_run_with_its_notes(api_client, run, staff):
    _note(api_client)
    assert api_client.delete(URL).status_code == 403

    api_client.force_authenticate(user=f.make_user(is_superuser=True))
    assert api_client.delete(URL).status_code == 200

    assert not run.exists()
    assert not ScreenReviewNote.objects.exists()


# -- the command ------------------------------------------------------------------------

def test_without_a_local_frontend_the_command_runs_the_screenshot_container(uploads, tmp_path, monkeypatch):
    from django.core.management import call_command

    from progeo.helper import docker_access

    calls = []

    def fake_run(run, devices, roles, languages, only, timeout_seconds, on_line):
        calls.append((run, devices, roles, languages, only, timeout_seconds))
        folder = uploads / "e2e" / run
        _png(folder / "pc" / "pc-user-login.png", (1440, 900))
        on_line("ok    pc-user-login.png")
        return {"exit_code": 0, "stdout": "", "stderr": "", "oom_killed": False, "timed_out": False}

    monkeypatch.setattr(docker_access, "run_e2e_screens", fake_run)
    out = io.StringIO()

    call_command("e2e_screenshots", "--frontend-dir", str(tmp_path / "no-frontend"), "--devices", "pc",
                 "--only", "login", stdout=out)

    assert calls[0][1:] == (["pc"], ["user", "staff"], ["de", "en"], ["login"], 3600)
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}_\d{6}", calls[0][0])
    assert "1 screenshot(s)" in out.getvalue()


def test_a_local_run_passes_the_dialog_switch_to_the_capture(uploads, tmp_path, monkeypatch):
    import shutil
    import subprocess

    from django.core.management import call_command

    frontend = tmp_path / "frontend"
    (frontend / "e2e" / "screenshots").mkdir(parents=True)
    (frontend / "e2e" / "screenshots" / "capture.mjs").write_text("")
    monkeypatch.setattr(shutil, "which", lambda name: f"/usr/bin/{name}")
    envs = []

    def fake_run(command, cwd, env, timeout, check):
        envs.append(env)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)

    call_command("e2e_screenshots", "--frontend-dir", str(frontend), "--base-url", "http://127.0.0.1:3000",
                 "--only", "staff-admin--staff-user-create", stdout=io.StringIO())
    call_command("e2e_screenshots", "--frontend-dir", str(frontend), "--base-url", "http://127.0.0.1:3000",
                 "--no-modals", stdout=io.StringIO())

    assert (envs[0]["SCREENS_ONLY"], envs[0]["SCREENS_MODALS"]) == ("staff-admin--staff-user-create", "1")
    assert envs[1]["SCREENS_MODALS"] == "0"


def test_the_container_run_takes_every_dialog(uploads):
    from django.core.management import call_command
    from django.core.management.base import CommandError

    with pytest.raises(CommandError, match="--no-modals needs a local frontend"):
        call_command("e2e_screenshots", "--docker", "--no-modals", stdout=io.StringIO())


def test_a_screenshot_container_that_cannot_run_leaves_no_empty_run(uploads, tmp_path, monkeypatch):
    from django.core.management import call_command
    from django.core.management.base import CommandError

    from progeo.helper import docker_access

    def broken(*args, **kwargs):
        raise docker_access.OperationFailed("Failed to run progeo-e2e_screens: no such image")

    monkeypatch.setattr(docker_access, "run_e2e_screens", broken)

    with pytest.raises(CommandError, match="--profile e2e_screens build"):
        call_command("e2e_screenshots", "--docker", stdout=io.StringIO())
    assert list((uploads / "e2e").iterdir()) == []


def test_folders_made_as_root_belong_to_the_app(uploads, monkeypatch):
    """`docker exec progeo-backend python manage.py e2e_screenshots` runs as
    root: the run's folders go to the app's user (the owner of
    media/uploads/) - the screenshot container writes there as that user."""
    import os

    uploads.mkdir(parents=True, exist_ok=True)
    owned = []
    real_stat = os.stat

    def fake_stat(path, *args, **kwargs):
        result = real_stat(path, *args, **kwargs)
        if str(path) == str(uploads):
            return os.stat_result((result.st_mode, 0, 0, 0, 1000, 1000, 0, 0, 0, 0))
        return result

    monkeypatch.setattr(os, "geteuid", lambda: 0, raising=False)
    monkeypatch.setattr(os, "stat", fake_stat)
    monkeypatch.setattr(os, "chown", lambda path, uid, gid: owned.append((str(path), uid, gid)), raising=False)

    folder = review.new_run_dir()

    owners = {path: (uid, gid) for path, uid, gid in owned}
    for path in (uploads / "e2e", folder, folder / "pc", folder / "mobile"):
        assert owners[str(path)] == (1000, 1000), path


def test_folders_made_by_the_app_keep_their_owner(uploads, monkeypatch):
    import os

    monkeypatch.setattr(os, "geteuid", lambda: 1000, raising=False)
    monkeypatch.setattr(os, "chown", lambda *args: pytest.fail("no chown as the app's user"), raising=False)

    assert review.new_run_dir().is_dir()


def test_screenshots_are_marked_reviewed_for_the_team(api_client, run, staff):
    url = f"{URL}reviewed/"

    marked = api_client.post(url, {"image": "mobile-user-login.png", "reviewed": True}, format="json").json()
    assert marked["reviewed"]["reviewed_by_name"] == "Jonas Weber"
    # Twice: still one mark, the first reviewer's.
    api_client.force_authenticate(
        user=f.make_user(staff=True, perms=("module_admin_screen_review",))
    )
    api_client.post(url, {"image": "mobile-user-login.png", "reviewed": True}, format="json")
    body = api_client.get(URL).json()
    assert [(mark["image"], mark["reviewed_by_name"]) for mark in body["reviewed"]] == [
        ("mobile-user-login.png", "Jonas Weber")]

    assert api_client.post(url, {"image": "mobile-user-login.png", "reviewed": False},
                           format="json").json()["reviewed"] is None
    assert api_client.get(URL).json()["reviewed"] == []
    assert api_client.post(url, {"image": "../secret.png", "reviewed": True}, format="json").status_code == 404
    assert api_client.post(url, {"image": "mobile-user-login.png", "reviewed": "yes"},
                           format="json").status_code == 400
