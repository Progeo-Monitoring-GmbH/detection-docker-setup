"""Export of the newly created Lageplan files as one tar archive (export_lageplans
command, StatusViewSet.admin_lageplan_export).

Every Lageplan is stored as its own file in UPLOAD_DIR/lageplan/
(creator.save_lageplan_upload) and never rewritten - a new plan is a new
file - so a file's modification time is when the plan was created.
"""
import os
import tarfile
import time

from progeo.settings import UPLOAD_DIR

LAGEPLAN_DIR = os.path.join(UPLOAD_DIR, "lageplan")
# The window grows by this factor until it holds a Lageplan - up to the
# newest one, however old.
WIDEN_FACTOR = 2


def lageplan_files(directory=None):
    """[(path, mtime)] of every file below `directory` (LAGEPLAN_DIR), newest first."""
    files = []
    directory = directory or LAGEPLAN_DIR
    for root, _dirs, names in os.walk(directory):
        for name in names:
            path = os.path.join(root, name)
            try:
                files.append((path, os.path.getmtime(path)))
            except OSError:
                continue  # removed meanwhile
    files.sort(key=lambda entry: entry[1], reverse=True)
    return files


def recent_lageplans(days, directory=None, now=None):
    """(files, days) - the Lageplan files created in the last `days` days. With
    none in that window it is widened (x WIDEN_FACTOR) until it holds at least
    one; `days` is the window used. No files at all: ([], days)."""
    now = time.time() if now is None else now
    days = max(1, days)
    files = lageplan_files(directory)
    if not files:
        return [], days
    newest_age = (now - files[0][1]) / 86400
    while days < newest_age:
        days *= WIDEN_FACTOR
    since = now - days * 86400
    return [entry for entry in files if entry[1] >= since], days


def write_lageplan_tar(files, target, directory=None):
    """Pack `files` ([(path, mtime)]) into the tar `target` (a path or a binary
    file object) as lageplan/<path below directory>."""
    directory = directory or LAGEPLAN_DIR
    kwargs = {"fileobj": target} if hasattr(target, "write") else {"name": target}
    with tarfile.open(mode="w", **kwargs) as tar:
        for path, _mtime in files:
            relative = os.path.relpath(path, directory).replace(os.sep, "/")
            tar.add(path, arcname=f"lageplan/{relative}", recursive=False)


def archive_name(days, now=None):
    """lageplans_<date>_<days>d.tar"""
    stamp = time.strftime("%Y%m%d-%H%M", time.localtime(time.time() if now is None else now))
    return f"lageplans_{stamp}_{days:g}d.tar"
