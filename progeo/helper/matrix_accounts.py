"""ProGeo accounts on our own Matrix server (compose profile "messenger").

Users never register there: the Matrix Authentication Service signs them in
through the portal (OpenID Connect, progeo/oidc.py) and creates the account
on the first login, named matrix_localpart(user). The profile shows the
resulting Matrix ID and a QR code with Element's provisioning link, which
opens the app with our server and the user's name already filled in.
"""
import base64
import io
import re
from urllib.parse import urlencode

from django.conf import settings

# The portal's OpenID Connect client for MAS (manage.py matrix_oidc_client)
# and MAS's id of the portal as login provider - the same in
# docker/matrix/mas_init.py, never to be changed (MAS links accounts to it).
OIDC_CLIENT_ID = "progeo-matrix"
MAS_PROVIDER_ID = "01M6GBK9WNWPFWH861CMP1EMFX"
# Localparts the server uses itself: the backend's bot and the Signal bridge
# (its bot and the "signal_<id>" ghosts of Signal contacts).
RESERVED_LOCALPARTS = {"progeo-bot", "signalbot", "admin", "root"}
RESERVED_PREFIXES = ("signal_", "_")
# Matrix allows a-z 0-9 . _ = - / + in localparts. "=" never occurs in a
# Django username, so the "=<pk>" suffix can't collide with a real name.
_INVALID = re.compile(r"[^a-z0-9._-]")
ELEMENT_PROVISIONING_LINK = "https://mobile.element.io/element"


def matrix_domain() -> str:
    return (getattr(settings, "MATRIX_DOMAIN", "") or "").strip()


def enabled() -> bool:
    """Our own Matrix server is set up (MATRIX_DOMAIN)."""
    return bool(matrix_domain())


def may_use_matrix(user) -> bool:
    """Real, active portal users - not the public demo, not a pending access
    request (they have no portal access yet either)."""
    from progeo.helper.access_requests import is_pending_user
    from progeo.helper.demo import is_demo_user

    return bool(user and user.is_authenticated and user.is_active
                and not is_demo_user(user) and not is_pending_user(user))


def matrix_localpart(user) -> str:
    """The user's Matrix name: the username where it is a valid localpart as
    it is, else lower-cased, invalid characters replaced and "=<pk>" appended
    ("Kai" and "kai" are two Django users) - unique and stable as long as the
    username is."""
    name = (user.username or "").strip()
    localpart = _INVALID.sub("_", name.lower())
    if (localpart != name or not localpart or localpart in RESERVED_LOCALPARTS
            or localpart.startswith(RESERVED_PREFIXES)):
        localpart = f"{localpart or 'user'}={user.pk}"
    return localpart


def matrix_user_id(user) -> str:
    return f"@{matrix_localpart(user)}:{matrix_domain()}"


def login_link(user) -> str:
    """Element X provisioning link: opens the app (or its store page) with
    our server and the user's name - the login then runs through the portal."""
    return f"{ELEMENT_PROVISIONING_LINK}?{urlencode({'account_provider': matrix_domain(), 'login_hint': user.username})}"


def qr_data_uri(payload: str) -> str:
    """`payload` as a PNG QR code data URI (for an <img>)."""
    import qrcode

    buffer = io.BytesIO()
    qrcode.make(payload, border=2).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def account_info(user) -> dict | None:
    """What the profile shows about the user's Matrix account, or None."""
    if not enabled() or not may_use_matrix(user):
        return None
    link = login_link(user)
    return {"user_id": matrix_user_id(user), "homeserver": matrix_domain(), "login_link": link,
            "qr": qr_data_uri(link)}
