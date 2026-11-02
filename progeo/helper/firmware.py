"""Flash bundles for the field app (STRATEGY.md section 4), stored in
settings.FIRMWARE_DIR. nginx serves that directory read-only and public at
/firmware/ (docker/nginx/snippets/firmware.conf):

  bundles/<name>.zip  .zip.sig  .zip.sha256    immutable once stored
  channels/<channel>.json  .json.sig           replaced on every release / promote

Written only by the upload API (v1/viewsets/firmware_viewset.py). The
signatures are verified by the app, not here: these checks only stop a broken
or mixed-up upload before it goes public.
"""
import hashlib
import json
import os
import re
import tempfile

from django.conf import settings

# The names nginx serves. Temp files start with a dot, so nginx never serves them.
BUNDLE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\.zip")
CHANNEL_NAME = re.compile(r"[a-z]+")
# "<key id>:<base64 of the raw Ed25519 signature>" (STRATEGY.md section 5).
SIGNATURE = re.compile(rb"[A-Za-z0-9._-]+:[A-Za-z0-9+/]+={0,2}\s*")

MAX_BUNDLE_SIZE = 16 * 1024 * 1024
MAX_CHANNEL_SIZE = 256 * 1024
MAX_SIGNATURE_SIZE = 1024


class FirmwareError(Exception):
    """Upload refused; `status` is the HTTP status of the answer."""

    def __init__(self, reason, status=400):
        super().__init__(reason)
        self.reason = reason
        self.status = status


def store_bundle(upload, signature, expected_sha256=""):
    """Stores a bundle zip (Django UploadedFile) with its .sig and .sha256.
    A stored zip is never replaced: the same bytes again are fine (a retry
    after a lost connection, it completes a missing .sig), other bytes under
    the same name are refused with 409 - a fix is a new release."""
    name = os.path.basename(upload.name or "")
    if not BUNDLE_NAME.fullmatch(name):
        raise FirmwareError(f"Invalid bundle file name {name!r} (expected lua-wlan-<bundle id>.zip)")
    if upload.size > MAX_BUNDLE_SIZE:
        raise FirmwareError(f"Bundle larger than {MAX_BUNDLE_SIZE} bytes", status=413)
    signature = _checked_signature(signature)

    directory = _directory("bundles")
    path = os.path.join(directory, name)
    temp, digest = _temp_file(directory, upload.chunks())
    try:
        if expected_sha256 and expected_sha256.lower() != digest:
            raise FirmwareError("sha256 does not match the uploaded bundle (transfer error?)")
        try:
            os.link(temp, path)  # atomic and never overwrites, unlike a rename
            created = True
        except FileExistsError:
            if _sha256(path) != digest:
                raise FirmwareError(f"{name} already exists with other content", status=409) from None
            created = False
    finally:
        os.unlink(temp)

    # After the zip: nothing lists it before its channel upload, which checks the .sig.
    _write_once(path + ".sig", signature)
    _write_once(path + ".sha256", f"{digest}  {name}\n".encode())
    return {"name": name, "url": f"bundles/{name}", "size": upload.size, "sha256": digest, "created": created}


def store_channel(channel, content, signature):
    """Replaces channels/<channel>.json and its .sig. Every bundle the file
    lists must be stored already, with the size and sha256 it states."""
    if not CHANNEL_NAME.fullmatch(channel or ""):
        raise FirmwareError(f"Invalid channel name {channel!r} (only a-z)")
    if len(content) > MAX_CHANNEL_SIZE:
        raise FirmwareError(f"Channel file larger than {MAX_CHANNEL_SIZE} bytes", status=413)
    try:
        data = json.loads(content)
    except ValueError:
        raise FirmwareError("Channel file is not valid JSON") from None
    if not isinstance(data, dict) or data.get("channel") != channel:
        raise FirmwareError(f"Channel file must be an object with \"channel\": \"{channel}\"")
    bundles = data.get("bundles")
    if not isinstance(bundles, list):
        raise FirmwareError("Channel file needs a \"bundles\" list")
    ids = {_check_listed_bundle(entry) for entry in bundles}
    if data.get("latest") is not None and data["latest"] not in ids:
        raise FirmwareError(f"\"latest\" {data['latest']!r} is not in \"bundles\"")
    signature = _checked_signature(signature)

    directory = _directory("channels")
    # Two renames, not one: an app that fetches in between gets a pair that
    # does not verify and tries again.
    _replace(os.path.join(directory, f"{channel}.json.sig"), signature)
    _replace(os.path.join(directory, f"{channel}.json"), content)
    return {"channel": channel, "bundles": len(bundles), "latest": data.get("latest")}


def _check_listed_bundle(entry):
    """The id of a channel file's bundle entry whose files are stored."""
    if not isinstance(entry, dict):
        raise FirmwareError("Every entry of \"bundles\" must be an object")
    url = entry.get("url")
    name = url.removeprefix("bundles/") if isinstance(url, str) else ""
    if url != f"bundles/{name}" or not BUNDLE_NAME.fullmatch(name):
        raise FirmwareError(f"Invalid bundle url {url!r} (expected bundles/<name>.zip)")
    if entry.get("sig_url") != f"{url}.sig":
        raise FirmwareError(f"\"sig_url\" of {name} must be {url}.sig")
    path = os.path.join(settings.FIRMWARE_DIR, "bundles", name)
    if not (os.path.isfile(path) and os.path.isfile(path + ".sig")):
        raise FirmwareError(f"{name} is not uploaded - upload the bundle first")
    if entry.get("size") != os.path.getsize(path) or entry.get("sha256") != _sha256(path):
        raise FirmwareError(f"size or sha256 of {name} do not match the stored bundle")
    return entry.get("id")


def _checked_signature(signature):
    if not signature or len(signature) > MAX_SIGNATURE_SIZE or not SIGNATURE.fullmatch(signature):
        raise FirmwareError("Missing or invalid signature (expected <key id>:<base64>)")
    return signature


def _directory(name):
    path = os.path.join(settings.FIRMWARE_DIR, name)
    os.makedirs(path, exist_ok=True)
    return path


def _temp_file(directory, chunks):
    """Writes the chunks to a hidden temp file in `directory` (same file
    system, so it can be moved into place) -> (path, sha256 hex)."""
    fd, path = tempfile.mkstemp(dir=directory, prefix=".upload-")
    digest = hashlib.sha256()
    try:
        with os.fdopen(fd, "wb") as out:
            for chunk in chunks:
                digest.update(chunk)
                out.write(chunk)
        os.chmod(path, 0o644)  # mkstemp makes 0600; nginx reads as another user
    except BaseException:
        os.unlink(path)
        raise
    return path, digest.hexdigest()


def _replace(path, content):
    temp, _ = _temp_file(os.path.dirname(path), [content])
    os.replace(temp, path)


def _write_once(path, content):
    """Writes a bundle's companion file unless it is there already; an
    existing one with other content is refused (bundles are immutable)."""
    if os.path.exists(path):
        with open(path, "rb") as existing:
            if existing.read() != content:
                raise FirmwareError(f"{os.path.basename(path)} already exists with other content", status=409)
        return
    _replace(path, content)


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
