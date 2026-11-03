"""ProGeo accounts on our own Matrix server (compose profile "messenger").

Users never register there: the Matrix Authentication Service signs them in
through the portal (OpenID Connect, progeo/oidc.py) and creates the account
on the first login, named matrix_localpart(user). The profile shows the
resulting Matrix ID and per chat app a QR code: for Element X its
provisioning link (opens the app with our server and the user's name), for
FluffyChat - which has no such link - its download page, the server is
typed in. Every login in an app passes the portal's token endpoint
(app_authorized): UserProfile.matrix_connected_at confirms the connection.
"""
import base64
import io
import re
from urllib.parse import urlencode

from django.conf import settings
from django.db.models.signals import post_delete, post_save, pre_save
from django.dispatch import receiver
from oauth2_provider.signals import app_authorized

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
FLUFFYCHAT_LINK = "https://fluffychat.im/"


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


def connected_at(user):
    """When the user last signed in to a chat app on our server, or None."""
    profile = getattr(user, "profile", None)
    return getattr(profile, "matrix_connected_at", None)


def account_info(user) -> dict | None:
    """What the profile shows about the user's Matrix account, or None:
    Matrix ID, last app login and per app the link + its QR code."""
    if not enabled() or not may_use_matrix(user):
        return None
    apps = {"element_x": login_link(user), "fluffychat": FLUFFYCHAT_LINK}
    return {
        "user_id": matrix_user_id(user),
        "homeserver": matrix_domain(),
        "connected_at": connected_at(user),
        "apps": {app: {"link": link, "qr": qr_data_uri(link)} for app, link in apps.items()},
    }


@receiver(app_authorized)
def remember_chat_login(sender, request, token, **kwargs):
    """The portal issued MAS a token: the user just signed in to a chat app."""
    if token.user_id is None or getattr(token.application, "client_id", None) != OIDC_CLIENT_ID:
        return
    from django.utils import timezone

    from progeo.v1.models import UserProfile

    UserProfile.objects.update_or_create(user_id=token.user_id, defaults={"matrix_connected_at": timezone.now()})


# ---------------------------------------------------------------------------- the account follows the portal user
#
# Deleting a portal user deactivates its chat account and has its content
# erased (GDPR), deactivating one deactivates it (reversible), reactivating
# reactivates it - through MAS's admin API (client credentials, scope
# urn:mas:admin; the admin API listens on progeo-mas:8081, which nginx never
# proxies). Matrix never frees an ID: a later user with the same username
# can't get that chat account.

PORTAL_ADMIN_CLIENT_ID = "01M6GQTJFXK52DY0ZYC0EEZK2Y"  # = docker/matrix/mas_init.py
MAS_URL = "http://progeo-mas:8080"
MAS_ADMIN_URL = "http://progeo-mas:8081"
ACCOUNT_ACTIONS = ("deactivate", "erase", "reactivate")


class MatrixAdminError(Exception):
    """A MAS admin API request failed."""


def admin_configured() -> bool:
    return enabled() and bool(getattr(settings, "MATRIX_MAS_ADMIN_SECRET", ""))


def _mas_request(method: str, url: str, **kwargs):
    import requests

    try:
        response = requests.request(method, url, timeout=15, **kwargs)
    except requests.RequestException as exc:
        raise MatrixAdminError(f"Could not reach MAS: {type(exc).__name__}: {exc}") from exc
    try:
        data = response.json() if response.text else {}
    except ValueError:
        data = {}
    return response, data


def _admin_token() -> str:
    response, data = _mas_request(
        "POST", f"{MAS_URL}/oauth2/token",
        data={"grant_type": "client_credentials", "scope": "urn:mas:admin"},
        auth=(PORTAL_ADMIN_CLIENT_ID, settings.MATRIX_MAS_ADMIN_SECRET),
    )
    token = data.get("access_token") if isinstance(data, dict) else None
    if not response.ok or not token:
        raise MatrixAdminError(f"MAS refused the admin token: HTTP {response.status_code} {response.text[:200]}")
    return token


def set_account_state(localpart: str, action: str) -> str:
    """`action` (deactivate / erase / reactivate) for the chat account
    `localpart`. Returns "done", "unchanged" or "missing" (never used the chat)."""
    from urllib.parse import quote

    if action not in ACCOUNT_ACTIONS:
        raise ValueError(action)
    headers = {"Authorization": f"Bearer {_admin_token()}"}
    response, data = _mas_request("GET", f"{MAS_ADMIN_URL}/api/admin/v1/users/by-username/{quote(localpart, safe='')}",
                                  headers=headers)
    if response.status_code == 404:
        return "missing"
    user = data.get("data") if isinstance(data, dict) else None
    if not response.ok or not isinstance(user, dict) or not user.get("id"):
        raise MatrixAdminError(f"MAS could not look up {localpart}: HTTP {response.status_code} {response.text[:200]}")
    deactivated = bool((user.get("attributes") or {}).get("deactivated_at"))
    if (action == "reactivate") != deactivated:
        return "unchanged"
    path = f"{MAS_ADMIN_URL}/api/admin/v1/users/{quote(user['id'], safe='')}/"
    if action == "reactivate":
        response, _data = _mas_request("POST", path + "reactivate", headers=headers)
    else:
        response, _data = _mas_request("POST", path + "deactivate", headers=headers,
                                       json={"skip_erase": action != "erase"})
    if not response.ok:
        raise MatrixAdminError(f"MAS could not {action} {localpart}: HTTP {response.status_code} {response.text[:200]}")
    return "done"


def _schedule(localpart: str, action: str) -> None:
    """set_account_state in the background, once the change is committed."""
    from django.db import transaction

    from progeo.helper import outbound
    from progeo.tasks import matrix_account_task

    transaction.on_commit(lambda: outbound.dispatch(matrix_account_task, localpart, action), using="default")


@receiver(pre_save, sender="auth.User")
def _remember_active(sender, instance, using=None, update_fields=None, **kwargs):
    instance._matrix_was_active = None
    if (using != "default" or not instance.pk or not admin_configured()
            or (update_fields is not None and "is_active" not in update_fields)):
        return
    instance._matrix_was_active = (
        sender.objects.using(using).filter(pk=instance.pk).values_list("is_active", flat=True).first()
    )


@receiver(post_save, sender="auth.User")
def _follow_active(sender, instance, using=None, **kwargs):
    was_active = getattr(instance, "_matrix_was_active", None)
    if was_active is None or was_active == instance.is_active:
        return
    if not instance.is_active:
        # Shown as not connected again if the user comes back.
        from progeo.v1.models import UserProfile

        UserProfile.objects.using("default").filter(user_id=instance.pk).update(matrix_connected_at=None)
    _schedule(matrix_localpart(instance), "reactivate" if instance.is_active else "deactivate")


@receiver(post_delete, sender="auth.User")
def _follow_delete(sender, instance, using=None, **kwargs):
    if using == "default" and admin_configured():
        _schedule(matrix_localpart(instance), "erase")
