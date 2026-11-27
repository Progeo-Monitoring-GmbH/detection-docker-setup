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
    # No name for a URL: left out.
    _png(folder / "pc" / "not a screenshot.png", (10, 10))
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


def test_a_new_run_gets_its_dated_folder_with_one_per_device(uploads):
    folder = review.new_run_dir()

    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}_\d{6}", folder.name)
    assert folder.parent == (uploads / "e2e").resolve()
    assert {child.name for child in folder.iterdir()} == {"pc", "mobile", "tablet", "tabletwide"}


@pytest.mark.parametrize("name, parsed", [
    ("pc-staff-en-location-overview.png", ("pc", "staff", "en", "location-overview", None)),
    ("mobile-user-login.png", ("mobile", "user", "de", "login", None)),
    ("pc-user-de-location-overview--user-profile.png", ("pc", "user", "de", "location-overview", "user-profile")),
    ("mobile-staff-en-staff-admin--staff-user-reset-two-factor-dialog.png",
     ("mobile", "staff", "en", "staff-admin", "staff-user-reset-two-factor-dialog")),
    ("tablet-staff-de-location-status.png", ("tablet", "staff", "de", "location-status", None)),
    ("tabletwide-user-en-location-status.png", ("tabletwide", "user", "en", "location-status", None)),
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
    ({"do": "click", "testId": "suspicion-mode-option", "key": "computed", "role": "staff"},
     'click [data-testid="suspicion-mode-option"][data-test-key="computed"] (as staff only)'),
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
    (RUN, "not a screenshot.png"),
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
    assert "3 open comment(s) on 2 screen(s): 1 × bigger, 1 × move, 1 × select." in prompt
    # Route and URL are the same here: only the URL.
    assert "- Page route:" not in prompt.split("## pc-staff-en-location-overview.png")[1].split("## ")[0]
    assert "language: en" in prompt
    ids = {note.comment: note.pk for note in ScreenReviewNote.objects.all()}
    assert (f"1. [#{ids['Nach rechts']}] **MOVE** · arrow from (100, 300) to (900, 320) · "
            "scope: this screen only: Nach rechts") in prompt
    assert (f"2. [#{ids['Tabelle zu klein']}] **BIGGER** · area x 40–640, y 1200–1500 · "
            "scope: this screen only: Tabelle zu klein") in prompt
    assert f"1. [#{ids['Logo fehlt']}] **SELECT** · the whole screen · scope: this screen only: Logo fehlt" in prompt
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


# ---------------------------------------------------------------------------- prompt improvements

def _export_prompt(api_client):
    archive = zipfile.ZipFile(io.BytesIO(api_client.get(f"{URL}export/").content))
    return archive, archive.read("PROMPT.md").decode("utf-8")


def test_a_general_note_belongs_to_the_run_and_leads_the_prompt(api_client, run, staff):
    response = api_client.post(f"{URL}notes/", {"image": "", "kind": "note", "action": "general",
                                               "comment": "Cut-offs unter 75 px nicht schneiden"}, format="json")
    assert response.status_code == 200
    note = response.json()["note"]
    assert (note["image"], note["kind"], note["scope"]) == ("", "note", "all")

    archive, prompt = _export_prompt(api_client)

    assert f"## General\n\n- [#{note['id']}] Cut-offs unter 75 px nicht schneiden" in prompt
    assert "1 open comment(s) on 0 screen(s) and 1 general one(s): 1 × general." in prompt
    assert [entry["image"] for entry in json.loads(archive.read("notes.json"))["notes"]] == [""]


@pytest.mark.parametrize("action", ["move", "question", "general"])
def test_moves_questions_and_general_notes_need_a_comment(api_client, run, staff, action):
    response = _note(api_client, action=action, comment="  ")
    assert response.status_code == 400
    assert not ScreenReviewNote.objects.exists()


def test_the_scope_says_where_else_a_comment_applies(api_client, run, staff):
    assert _note(api_client, scope="planet").status_code == 400
    _note(api_client, image="mobile-user-login.png", kind="note", action="question", geometry=None,
          comment="Gibt es den Knopf auch am PC?", scope="device")
    _note(api_client, kind="note", action="select", geometry=None, comment="Fett", scope="all")

    _archive, prompt = _export_prompt(api_client)

    assert "**QUESTION** · the whole screen · scope: every phone screen - fix it everywhere it shows there" in prompt
    assert "**SELECT** · the whole screen · scope: everywhere (every device and page)" in prompt
    assert review.ACTION_TEXT["question"] in prompt


def test_done_comments_are_left_out_of_the_prompt(api_client, run, staff):
    kept = _note(api_client, comment="Bleibt").json()["note"]
    # An older note without the comment a move needs now: marking it done still works.
    old = ScreenReviewNote.objects.create(run=RUN, image="pc-staff-en-location-overview.png", kind="arrow",
                                          action="move", comment="",
                                          geometry={"x1": 1, "y1": 2, "x2": 3, "y2": 4})

    done = api_client.patch(f"{URL}notes/{old.pk}/", {"done": True}, format="json").json()["note"]
    assert done["done"] and done["done_by_name"] == "Jonas Weber" and done["done_at"]
    assert api_client.patch(f"{URL}notes/{old.pk}/", {"done": "yes"}, format="json").status_code == 400

    archive, prompt = _export_prompt(api_client)

    assert f"[#{kept['id']}]" in prompt and f"[#{old.pk}]" not in prompt
    assert "1 comment(s) marked done are left out." in prompt
    # notes.json keeps them all - with their state.
    states = {entry["id"]: entry["done"] for entry in json.loads(archive.read("notes.json"))["notes"]}
    assert states == {kept["id"]: False, old.pk: True}

    reopened = api_client.patch(f"{URL}notes/{old.pk}/", {"done": False}, format="json").json()["note"]
    assert not reopened["done"] and reopened["done_at"] is None


def test_the_prompt_names_the_elements_under_a_comment_and_who_was_signed_in(api_client, run, staff):
    elements = [
        {"t": "page-locations", "g": "div", "s": "Objekte", "r": [0, 0, 1440, 2600]},
        {"t": "locations-filter", "g": "div", "s": "Filter", "r": [80, 280, 400, 60]},
        {"t": "locations-search", "g": "input", "s": "Suchen", "r": [90, 290, 200, 40]},
        {"t": "locations-export", "k": "csv", "g": "button", "s": "Export", "r": [880, 300, 60, 40]},
        {"g": "button", "s": "Mit Airtable abgleichen", "r": [40, 1210, 300, 40]},
    ]
    (run / "pc" / "pc-staff-en-location-overview.elements.json").write_text(
        json.dumps({"elements": elements}), encoding="utf-8")
    manifest = json.loads((run / "manifest.json").read_text(encoding="utf-8"))
    manifest["images"][0]["persona"] = {"username": "staff.weber", "is_staff": True, "is_superuser": True,
                                        "permissions": []}
    (run / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    _note(api_client)  # arrow from (100, 300) to (900, 320)
    _note(api_client, kind="area", action="remove", comment="Weg",
          geometry={"x": 30, "y": 1200, "w": 320, "h": 60})

    archive, prompt = _export_prompt(api_client)

    assert '   - Arrow starts on: `[data-testid="locations-search"]` "Suchen" (input)' in prompt
    assert ('   - Arrow points at: `[data-testid="locations-export"][data-test-key="csv"]` "Export" (button)'
            in prompt)
    assert '   - Marks: `<button>` "Mit Airtable abgleichen"' in prompt
    assert "- Signed in as: staff `staff.weber` (staff, superuser" in prompt
    targets = {entry["comment"]: entry["targets"] for entry in json.loads(archive.read("notes.json"))["notes"]}
    assert targets["Weg"] == {"area": ['`<button>` "Mit Airtable abgleichen"']}


# ---------------------------------------------------------------------------- screenshots from elsewhere
# Folders somebody put into media/uploads/e2e/ by hand - e.g. the screenshots
# of another app: any folder name, any PNG name, in pc/, mobile/ or loose.

LOOSE_RUN = "android-lua-flasher"


@pytest.fixture
def loose_run(uploads):
    folder = uploads / "e2e" / LOOSE_RUN
    _png(folder / "00-login.png", (1080, 2160))
    _png(folder / "05b-profile-editor-values-middle.png", (1080, 2160))
    _png(folder / "Wide_Screen.png", (1920, 1080))
    _png(folder / "pc" / "settings.png", (300, 900))  # the folder says pc, whatever its shape
    _png(folder / "mobile" / "mobile-staff-en-login.png", (390, 900))  # our pattern still counts
    (folder / "readme.txt").write_text("not an image", encoding="utf-8")
    _png(folder / "sub" / "nested.png", (10, 10))  # only pc/, mobile/ and the folder itself
    _png(folder / "has space.png", (10, 10))  # no name for a URL
    return folder


def test_images_without_our_name_pattern_are_listed(loose_run):
    images = {image["file"]: image for image in review.run_images(LOOSE_RUN)}

    assert set(images) == {"00-login.png", "05b-profile-editor-values-middle.png", "Wide_Screen.png",
                           "settings.png", "mobile-staff-en-login.png"}
    middle = images["05b-profile-editor-values-middle.png"]
    # Portrait: a phone. The action is the file's name; role and language are the defaults.
    assert (middle["device"], middle["role"], middle["language"], middle["action"], middle["modal"]) == (
        "mobile", "user", "de", "05b-profile-editor-values-middle", None)
    assert (middle["width"], middle["height"]) == (1080, 2160)
    assert (images["Wide_Screen.png"]["device"], images["Wide_Screen.png"]["action"]) == ("pc", "wide-screen")
    assert images["settings.png"]["device"] == "pc"
    named = images["mobile-staff-en-login.png"]
    assert (named["device"], named["role"], named["language"], named["action"]) == ("mobile", "staff", "en", "login")


def test_a_folder_without_a_date_is_a_run(loose_run, run):
    runs = {entry["run"]: entry for entry in review.list_runs()}

    assert set(runs) == {RUN, LOOSE_RUN}
    assert runs[LOOSE_RUN]["images"] == 5
    assert runs[LOOSE_RUN]["created"]  # the folder's time
    assert review.list_runs()[0]["run"] == LOOSE_RUN  # just made: newest first


@pytest.mark.parametrize("name", ["x.part", ".hidden", "fetch", "a b", "x" * 33])
def test_folders_that_are_no_runs(uploads, name):
    _png(uploads / "e2e" / name / "one.png", (10, 10))

    assert review.list_runs() == []
    with pytest.raises(review.ReviewError):
        review.run_dir(name)


@pytest.mark.parametrize("image", ["../00-login.png", "sub/nested.png", "nested.png", "readme.txt", "has space.png",
                                   "missing.png", "..png", "manifest.json"])
def test_only_the_pngs_of_a_loose_run_are_served(loose_run, image):
    with pytest.raises(review.ReviewError):
        review.image_path(LOOSE_RUN, image)


def test_loose_images_are_found_in_their_folder(loose_run):
    assert review.image_path(LOOSE_RUN, "00-login.png") == loose_run / "00-login.png"
    assert review.image_path(LOOSE_RUN, "settings.png") == loose_run / "pc" / "settings.png"
    assert review.image_path(LOOSE_RUN, "mobile-staff-en-login.png") == loose_run / "mobile" / "mobile-staff-en-login.png"


def test_a_loose_run_works_through_the_api(api_client, loose_run, staff):
    url = f"/v1/screen-review/{LOOSE_RUN}/"

    listed = api_client.get("/v1/screen-review/").json()["runs"]
    assert [entry["run"] for entry in listed] == [LOOSE_RUN]
    detail = api_client.get(url)
    assert detail.status_code == 200, detail.content
    assert len(detail.json()["images"]) == 5
    image = api_client.get(f"{url}image/Wide_Screen.png/")
    assert image.status_code == 200
    assert image["Content-Type"] == "image/png"

    note = api_client.post(f"{url}notes/", {"image": "05b-profile-editor-values-middle.png", "kind": "area",
                                            "action": "remove", "comment": "weg damit",
                                            "geometry": {"x": 10, "y": 20, "w": 100, "h": 50}}, format="json")
    assert note.status_code == 200, note.content

    exported = api_client.get(f"{url}export/")
    assert exported.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(exported.content)).namelist()
    assert "screens/05b-profile-editor-values-middle.png" in names
