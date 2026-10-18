"""Shared constants of the public demo view (see the demo_account command and
progeo/v1/viewsets/demo_viewset.py)."""

import os

from progeo.settings import MEDIA_ROOT, UPLOAD_DIR

DEMO_ACCOUNT_HASH = "demo-account"
DEMO_ACCOUNT_NAME = "Demo"
DEMO_USERNAME = "demo"
DEMO_TOKEN_PURPOSE = "demo"
DEMO_PERMISSION = "module_demo_enabled"
# Lageplan file name (relative to UPLOAD_DIR) of the demo locations.
DEMO_LAGEPLAN_PREFIX_REL = "lageplan/demo_"
# The same as media path; the media view lets demo-only users fetch nothing else.
DEMO_LAGEPLAN_PREFIX = os.path.relpath(UPLOAD_DIR, MEDIA_ROOT).replace(os.sep, "/") + "/" + DEMO_LAGEPLAN_PREFIX_REL
