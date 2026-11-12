"""Remote firmware updates of the controllers (LUA_WLAN MIGRATE.md): the
server takes a controller from the flash bundle it runs to a newer (or older)
one on the same firmware - over its command poll, without anybody on site.

What a controller can take remotely is its SPIFFS files and its LFS image: the
C firmware (and with it the LFS partition) only changes with a flash on site
(the Android app), and an LFS image only runs on the firmware it was built
for. So a target on another firmware is refused with that reason.

One update is one or more steps (hops) from the running bundle towards the
target, each an "upgrade" command:

1. plan_hop: the next bundle - the target, or the first bundle marked
   "stop": true in its bundle.json on the way there - and the files that
   differ between the two bundle.json manifests (changed or new SPIFFS
   files, init.lua, lfs.img last), plus the files to delete.
2. When the next bundle has another config schema, the server first reads
   the controller's config/device_config.lua ("get_config", marked with
   summary["upgrade"]), migrates it (helper/config_migrations.py) and sends
   it along. The file holds secrets: kept encrypted (files_encrypted) only
   until the update step finished.
3. "upgrade" payload (fits the controller's 4 KB poll answer):

       {"bundle": "<next bundle id>",
        "files": [{"path": "config/runtime_config.lua", "size": 912, "url": "cc/file/77/0/"},
                  {"path": "lfs.img", "size": 118272, "url": "cc/file/77/1/"}],
        "delete": ["old.lua"]}

   The controller downloads every url (relative to its control.url, with
   its token, byte ranges allowed - download_file) and installs them.
4. Its result ({"id": 77, "ok": true}) - sent once it runs the new bundle -
   finishes the step; the next hop follows until the target is reached.
   The controller reports the bundle it runs in every message ("bundle",
   note_bundle), which is where the next update starts.

No hash on the controller: a check of the size, of the Lua files by
loading them and of the image by node.LFS.reload keeps it light (MIGRATE.md).
"""
import functools
import hashlib
import json
import os
import re
import zipfile
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from progeo.helper import config_migrations
from progeo.v1.models import ProgeoDevice, ProgeoDeviceCommand

Command = ProgeoDeviceCommand.Command
Status = ProgeoDeviceCommand.Status

BUNDLE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}")
MANIFEST = "bundle.json"
DEVICE_CONFIG = "config/device_config.lua"
# Never written from a bundle: the controller's own config and wifi credentials.
PROTECTED_PATHS = {DEVICE_CONFIG, "config/wifi_config.lua"}
LFS_PATH = "lfs.img"
INIT_PATH = "init.lua"
SAFE_PATH = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.\-/]{0,99}$")
# The controller reads at most 4 KB of a poll answer - with the other commands.
PAYLOAD_MAX_BYTES = 3 * 1024
# Files a timed-out step may still download (it goes on over several boots).
DOWNLOAD_WINDOW = timedelta(hours=24)


class UpdateError(ValueError):
    pass


# ---------------------------------------------------------------------------- bundles

def bundle_path(bundle_id):
    if not isinstance(bundle_id, str) or not BUNDLE_ID.fullmatch(bundle_id):
        raise UpdateError(f"Invalid bundle id {bundle_id!r}")
    return os.path.join(settings.FIRMWARE_DIR, "bundles", f"lua-wlan-{bundle_id}.zip")


@functools.lru_cache(maxsize=64)
def _read_manifest(path, _mtime, _size):
    with zipfile.ZipFile(path) as bundle:
        data = json.loads(bundle.read(MANIFEST))
    if not isinstance(data, dict) or not isinstance(data.get("firmware"), dict):
        raise UpdateError(f"{os.path.basename(path)} has no valid {MANIFEST}")
    for key in ("lfs", "init"):
        if not isinstance(data.get(key), dict):
            raise UpdateError(f"{os.path.basename(path)}: {MANIFEST} lacks {key!r}")
    return data


def manifest(bundle_id):
    """The bundle.json of a stored bundle (cached - bundles never change)."""
    path = bundle_path(bundle_id)
    try:
        stat = os.stat(path)
        return _read_manifest(path, stat.st_mtime, stat.st_size)
    except FileNotFoundError:
        raise UpdateError(f"The server does not hold bundle {bundle_id}") from None
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as exc:
        if isinstance(exc, UpdateError):
            raise
        raise UpdateError(f"Bundle {bundle_id} cannot be read: {exc}") from None


def bundle_member(bundle_id, member):
    with zipfile.ZipFile(bundle_path(bundle_id)) as bundle:
        return bundle.read(member)


def _firmware(data):
    firmware = data["firmware"]
    return firmware.get("version"), firmware.get("lfs_size")


def _schema(data):
    return int(data.get("config_schema") or 0)


# ---------------------------------------------------------------------------- planning

def _hop_files(old, new):
    """(files of `new` differing from `old` - SPIFFS files, then init.lua,
    lfs.img last -, paths to delete)."""
    def checked(path):
        if not isinstance(path, str) or not SAFE_PATH.match(path) or ".." in path.split("/"):
            raise UpdateError(f"Invalid file path {path!r} in the bundle")
        if path in PROTECTED_PATHS:
            raise UpdateError(f"The bundle must not contain {path}")
        return path

    before = {checked(entry["path"]): entry.get("sha256") for entry in old.get("files") or []}
    after = new.get("files") or []
    files = [
        {"path": checked(entry["path"]), "member": entry["file"], "size": entry["size"], "sha256": entry["sha256"]}
        for entry in after
        if before.get(entry["path"]) != entry.get("sha256")
    ]
    for path, key in ((INIT_PATH, "init"), (LFS_PATH, "lfs")):
        if old[key].get("sha256") != new[key].get("sha256"):
            entry = new[key]
            files.append({"path": path, "member": entry["file"], "size": entry["size"], "sha256": entry["sha256"]})
    delete = sorted(set(before) - {entry["path"] for entry in after})
    return files, delete


def hop(from_bundle, to_bundle, target=None):
    """The step from_bundle -> to_bundle: {"from", "to", "target",
    "from_schema", "to_schema", "files", "delete"}."""
    old, new = manifest(from_bundle), manifest(to_bundle)
    if _firmware(old) != _firmware(new):
        raise UpdateError(
            f"{to_bundle} needs firmware {new['firmware'].get('version')} (lfs {new['firmware'].get('lfs_size')}), "
            f"the device runs {old['firmware'].get('version')} (lfs {old['firmware'].get('lfs_size')}) - "
            "flash it on site with the app"
        )
    if _schema(new) < _schema(old):
        raise UpdateError(
            f"{to_bundle} has config schema {_schema(new)}, the device {_schema(old)} - a config cannot go back"
        )
    files, delete = _hop_files(old, new)
    return {
        "from": from_bundle,
        "to": to_bundle,
        "target": target or to_bundle,
        "from_schema": _schema(old),
        "to_schema": _schema(new),
        "files": files,
        "delete": delete,
    }


def plan_hop(current, target):
    """The next step from `current` towards `target`: straight there, unless
    a bundle the server lists on the way is marked "stop" (it has to be
    installed on the way - e.g. it converts something on the controller
    the later ones rely on). Raises UpdateError with the reason it is not
    possible remotely."""
    from progeo.helper.firmware import list_bundles

    if current == target:
        raise UpdateError(f"The device runs {target} already")
    old, new = manifest(current), manifest(target)
    following = str(new.get("created") or "") > str(old.get("created") or "")
    next_bundle = target
    if following:
        low, high = str(old.get("created") or ""), str(new.get("created") or "")
        stops = []
        for listed in list_bundles():
            if listed["id"] in (current, target):
                continue
            try:
                data = manifest(listed["id"])
            except UpdateError:
                continue
            created = str(data.get("created") or "")
            if data.get("stop") and low < created < high and _firmware(data) == _firmware(old):
                stops.append((created, listed["id"]))
        if stops:
            next_bundle = min(stops)[1]
    return hop(current, next_bundle, target)


# ---------------------------------------------------------------------------- state

def _update_commands(device, db_name):
    """The device's commands of firmware updates, newest first."""
    return [
        command
        for command in ProgeoDeviceCommand.objects.using(db_name)
        .filter(device_id=device.pk, command__in=[Command.UPGRADE, Command.GET_CONFIG])
        .order_by("-pk")[:50]
        if command.command == Command.UPGRADE or (command.summary or {}).get("upgrade")
    ]


def _running(command, now=None):
    """Queued, taken, or taken without an answer while its files can still be
    downloaded - a step that never answered does not block the device forever."""
    if command.status in (Status.PENDING, Status.SENT):
        return True
    now = now or timezone.now()
    return command.status == Status.TIMEOUT and command.sent_at is not None and \
        command.sent_at >= now - DOWNLOAD_WINDOW


def open_update(device, db_name):
    """The update step running on the device, None if there is none."""
    now = timezone.now()
    return next((command for command in _update_commands(device, db_name) if _running(command, now)), None)


def update_state(device, db_name):
    """The newest update step as the frontend shows it, None without any."""
    command = next(iter(_update_commands(device, db_name)), None)
    if command is None:
        return None
    step = (command.summary or {}).get("upgrade") or {}
    return {
        "command_id": command.pk,
        "phase": "reading_config" if command.command == Command.GET_CONFIG else "upgrading",
        "status": command.status,
        # Blocks a new update (open_update) - a long silent step does not.
        "running": _running(command),
        "from": step.get("from"),
        "to": step.get("to"),
        "target": step.get("target"),
        "error": command.error or None,
        "created": command.created.isoformat() if command.created else None,
        "finished_at": command.finished_at.isoformat() if command.finished_at else None,
    }


def note_bundle(device, db_name, message):
    """Store the bundle a controller reports ("bundle" of its messages)."""
    bundle = message.get("bundle") if isinstance(message, dict) else None
    if not isinstance(bundle, str) or not BUNDLE_ID.fullmatch(bundle) or bundle == device.firmware_bundle:
        return
    device.firmware_bundle = bundle
    ProgeoDevice.objects.using(db_name).filter(pk=device.pk).update(firmware_bundle=bundle)


# ---------------------------------------------------------------------------- queueing

def _step_summary(step):
    return {key: step[key] for key in ("from", "to", "target", "from_schema", "to_schema")}


def start_update(device, db_name, target, user=None):
    """Start taking the device to `target` (a bundle the server holds):
    queues the first step - "get_config" when the config needs a
    migration, else "upgrade". Returns the queued command."""
    if not device.firmware_bundle:
        raise UpdateError(
            "The device does not report its bundle - it needs a release that can update itself, flashed on site once"
        )
    with transaction.atomic(using=db_name):
        ProgeoDevice.objects.using(db_name).select_for_update().filter(pk=device.pk).first()
        if open_update(device, db_name) is not None:
            raise UpdateError("An update of this device is running already")
        return _queue_step(device, db_name, plan_hop(device.firmware_bundle, target), _user_id(user, db_name))


def _queue_step(device, db_name, step, user_id):
    if step["to_schema"] != step["from_schema"]:
        # The config is migrated first - with what the controller has now.
        return ProgeoDeviceCommand.objects.using(db_name).create(
            device_id=device.pk,
            command=Command.GET_CONFIG,
            summary={"path": DEVICE_CONFIG, "upgrade": _step_summary(step)},
            payload_encrypted="",
            created_by_id=user_id,
        )
    return _queue_upgrade(device, db_name, step, user_id)


def _queue_upgrade(device, db_name, step, user_id, config_text=None):
    from progeo.helper.device_commands import encrypt

    files = [dict(entry) for entry in step["files"]]
    private = {}
    if config_text is not None:
        encoded = config_text.encode("utf-8")
        private[DEVICE_CONFIG] = config_text
        # Before init.lua and lfs.img: the new code finds its config.
        spiffs = sum(1 for entry in files if entry["path"] not in (INIT_PATH, LFS_PATH))
        files.insert(spiffs, {
            "path": DEVICE_CONFIG, "member": None, "size": len(encoded),
            "sha256": hashlib.sha256(encoded).hexdigest(),
        })
    if not files and not step["delete"]:
        raise UpdateError(f"{step['from']} and {step['to']} have the same files - nothing to send")

    command = ProgeoDeviceCommand.objects.using(db_name).create(
        device_id=device.pk,
        command=Command.UPGRADE,
        summary={
            "upgrade": _step_summary(step),
            # path, size, sha256 and the zip member - the content of the config never.
            "files": files,
            "delete": step["delete"],
        },
        created_by_id=user_id,
    )
    payload = {
        "bundle": step["to"],
        "files": [
            {"path": entry["path"], "size": entry["size"], "url": f"cc/file/{command.pk}/{index}/"}
            for index, entry in enumerate(files)
        ],
        "delete": step["delete"],
    }
    if len(json.dumps(payload, separators=(",", ":"))) > PAYLOAD_MAX_BYTES:
        raise UpdateError(f"The upgrade to {step['to']} lists too many files for the controller's poll answer")
    command.payload_encrypted = encrypt(payload)
    command.files_encrypted = encrypt(private) if private else ""
    command.save(using=db_name, update_fields=["payload_encrypted", "files_encrypted"])
    return command


def _failed_step(device, db_name, step, user_id, reason):
    """An "upgrade" that could not be queued - in the history with its reason."""
    now = timezone.now()
    return ProgeoDeviceCommand.objects.using(db_name).create(
        device_id=device.pk,
        command=Command.UPGRADE,
        status=Status.FAILED,
        finished_at=now,
        summary={"upgrade": _step_summary(step)},
        error=str(reason)[:500],
        created_by_id=user_id,
    )


def _user_id(user, db_name):
    from progeo.helper.device_commands import _mirrored_user_id

    return _mirrored_user_id(user, db_name)


def after_results(device, db_name, commands):
    """Go on with an update after the controller reported on `commands`
    (device_commands.record_results, inside its transaction): a config read
    for an update -> migrate it and queue the "upgrade"; a finished
    "upgrade" -> drop its files, and queue the next step until the target
    is reached."""
    from progeo.helper.device_commands import decrypt

    for command in commands:
        step = (command.summary or {}).get("upgrade")
        if not step:
            continue
        if command.command == Command.GET_CONFIG:
            if command.status != Status.SUCCESS:
                continue
            result = decrypt(command.result_encrypted) or {}
            content = result.get("content") if isinstance(result, dict) else None
            try:
                if not isinstance(content, str) or not content.strip():
                    raise UpdateError("The controller sent no config")
                planned = hop(step["from"], step["to"], step["target"])
                text = config_migrations.migrate(content, planned["from_schema"], planned["to_schema"])
                if "firmware" in config_migrations._sections(text):
                    text = config_migrations.set_value(
                        text, "firmware", "bundle", config_migrations.lua_string(planned["to"])
                    )
                _queue_upgrade(device, db_name, planned, command.created_by_id, config_text=text)
            except (UpdateError, config_migrations.ConfigMigrationError) as exc:
                _failed_step(device, db_name, step, command.created_by_id, exc)
        elif command.command == Command.UPGRADE:
            if command.files_encrypted:
                command.files_encrypted = ""
                command.save(using=db_name, update_fields=["files_encrypted"])
            if command.status != Status.SUCCESS:
                continue
            device.firmware_bundle = step["to"]
            ProgeoDevice.objects.using(db_name).filter(pk=device.pk).update(firmware_bundle=step["to"])
            if step["to"] == step["target"]:
                continue
            try:
                _queue_step(device, db_name, plan_hop(step["to"], step["target"]), command.created_by_id)
            except UpdateError as exc:
                _failed_step(device, db_name, {**step, "from": step["to"], "to": step["target"]}, command.created_by_id, exc)


def housekeeping(commands):
    """Drop the files of steps that finished or stopped downloading
    (device_commands.housekeeping, per device)."""
    now = timezone.now()
    stale = commands.exclude(files_encrypted="").filter(command=Command.UPGRADE)
    stale.exclude(status__in=[Status.PENDING, Status.SENT, Status.TIMEOUT]).update(files_encrypted="")
    stale.filter(sent_at__lt=now - DOWNLOAD_WINDOW).update(files_encrypted="")


# ---------------------------------------------------------------------------- downloads

def download_file(raw_hash, command_id, index):
    """(path, bytes) of file `index` of the device's "upgrade" `command_id`
    - one it took and has not finished. UpdateError if there is none."""
    from progeo.helper.device_commands import decrypt, device_db

    db_name = device_db(raw_hash)
    device = ProgeoDevice.objects.using(db_name).filter(raw_hash=raw_hash).first() if db_name else None
    command = None
    if device is not None:
        command = ProgeoDeviceCommand.objects.using(db_name).filter(
            device_id=device.pk, pk=command_id, command=Command.UPGRADE,
            status__in=[Status.SENT, Status.TIMEOUT], sent_at__gte=timezone.now() - DOWNLOAD_WINDOW,
        ).first()
    files = ((command.summary or {}).get("files") or []) if command else []
    if not 0 <= index < len(files):
        raise UpdateError("No such file")
    entry = files[index]
    if entry.get("member"):
        data = bundle_member(command.summary["upgrade"]["to"], entry["member"])
    else:
        private = decrypt(command.files_encrypted) or {}
        if entry["path"] not in private:
            raise UpdateError("The file is not kept any more")
        data = private[entry["path"]].encode("utf-8")
    if len(data) != entry["size"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
        raise UpdateError(f"{entry['path']} does not match the bundle")
    return entry["path"], data
