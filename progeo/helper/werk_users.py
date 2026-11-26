"""Factory accounts (docs/fertigung.md 1a): who may use the /v1/werk/ endpoints, the
app's "who am I" and the sync of the Airtable "Ressourcen" with a ticked
"Werk-App" box into backend accounts (group "Werk", not staff).

- is_factory_user(): staff, superuser or group "Werk".
- me(): GET /v1/werk/ich/.
- sync(): `manage.py sync_werk_users`, celery (nightly), staff button.
"""

import re
import unicodedata

from django.conf import settings
from django.contrib.auth.models import Group, User
from django.db import DEFAULT_DB_ALIAS, transaction
from django.utils import timezone

from progeo.helper.basics import elog, ilog, wlog

DB = DEFAULT_DB_ALIAS
GROUP = "Werk"

_TRANSLIT = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue"})


def is_factory_user(user) -> bool:
    if user is None or not getattr(user, "is_authenticated", False) or not user.is_active:
        return False
    if user.is_staff:
        return True
    if user.is_superuser:
        return True
    return user.groups.filter(name=GROUP).exists()


def factory_users_by_name(usernames):
    """{username: User} of the active factory accounts among `usernames`."""
    users = User.objects.using(DB).filter(username__in=set(usernames), is_active=True)
    return {user.username: user for user in users if is_factory_user(user)}


def initials(name) -> str:
    words = [word for word in re.split(r"[\s\-]+", str(name or "")) if word]
    if not words:
        return ""
    if len(words) == 1:
        return words[0][:2].upper()
    return (words[0][0] + words[-1][0]).upper()


def _werk_user(user):
    from progeo.v1.models import ProgeoWerkUser

    return ProgeoWerkUser.objects.using(DB).filter(user=user).first()


def display_name(user) -> str:
    werk = _werk_user(user)
    return (werk.name if werk else "") or user.get_full_name() or user.username


def abbreviation(user) -> str:
    werk = _werk_user(user)
    if werk and werk.kuerzel:
        return werk.kuerzel
    return initials(display_name(user)) or user.username[:2].upper()


def resource_id(user):
    """The Airtable "Ressourcen" record of `user` ("Produziert von"), else None."""
    werk = _werk_user(user) if user is not None else None
    return werk.airtable_resource_id if werk else None


def me(user) -> dict:
    """GET /v1/werk/ich/ - only asked for factory accounts."""
    return {"benutzer": user.username, "name": display_name(user), "kuerzel": abbreviation(user), "werk": True}


# ---------------------------------------------------------------------------- sync

def _ascii(text) -> str:
    text = str(text or "").translate(_TRANSLIT)
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()


def make_username(email, name) -> str:
    """"m.muster@…" -> "m.muster"; without an address "Max Muster" -> "m.muster"."""
    if email and "@" in email:
        base = email.split("@", 1)[0]
    else:
        words = _ascii(name).split()
        base = f"{words[0][0]}.{words[-1]}" if len(words) >= 2 else (words[0] if words else "werk")
    base = re.sub(r"[^a-z0-9._-]", "", _ascii(base).lower()).strip("._-") or "werk"
    return base[:140]


def _unique_username(base) -> str:
    username, number = base, 1
    while User.objects.using(DB).filter(username=username).exists():
        number += 1
        username = f"{base}{number}"
    return username


def _queue_invite(user_id):
    try:
        from progeo.tasks import send_login_link_task

        send_login_link_task.delay(user_id, "invite")
    except Exception as error:  # noqa: BLE001 - the account exists, staff can invite by hand
        elog(f"Could not queue the invitation of factory user {user_id}: {error}", tag="[WERK]")


def resources_table_name():
    return getattr(settings, "AIRTABLE_RESOURCES_TABLE", "Ressourcen")


def fetch_resources(helper):
    """The "Ressourcen" rows with a ticked "Werk-App" box: [{id, name, email}]."""
    box = getattr(settings, "AIRTABLE_RESOURCES_WERK_FIELD", "Werk-App")
    name_field, mail_field = "Name", "E-Mail Adresse"
    records = helper.table(resources_table_name()).all(
        formula=f"{{{box}}}", fields=[name_field, mail_field, box],
    )
    return [
        {
            "id": record["id"],
            "name": str(record.get("fields", {}).get(name_field) or "").strip(),
            "email": str(record.get("fields", {}).get(mail_field) or "").strip().lower(),
        }
        for record in records
    ]


def sync(helper=None, invite=True) -> dict:
    """Creates/updates the accounts of the ticked resources, deactivates the
    ones no longer ticked. Returns the counts."""
    from progeo.helper.airtable import AirtableHelper
    from progeo.v1.models import ProgeoWerkUser

    helper = helper or AirtableHelper()
    if not helper.configured:
        raise RuntimeError("Airtable is not configured")
    resources = fetch_resources(helper)
    group, _created = Group.objects.using(DB).get_or_create(name=GROUP)
    counts = {"angelegt": 0, "aktualisiert": 0, "deaktiviert": 0, "eingeladen": 0, "uebersprungen": 0}
    now = timezone.now()
    with transaction.atomic(using=DB):
        for resource in resources:
            link = ProgeoWerkUser.objects.using(DB).select_related("user").filter(
                airtable_resource_id=resource["id"]).first()
            if link is not None:
                user = link.user
                counts["aktualisiert"] += 1
            else:
                user = None
                if resource["email"]:
                    user = User.objects.using(DB).filter(email__iexact=resource["email"]).first()
                if user is not None and ProgeoWerkUser.objects.using(DB).filter(user=user).exists():
                    wlog(f"Resource {resource['id']}: {user.username} is linked to another resource", tag="[WERK]")
                    counts["uebersprungen"] += 1
                    continue
                if user is None:
                    words = resource["name"].split()
                    user = User(
                        username=_unique_username(make_username(resource["email"], resource["name"])),
                        email=resource["email"],
                        first_name=" ".join(words[:-1])[:150] if len(words) > 1 else resource["name"][:150],
                        last_name=words[-1][:150] if len(words) > 1 else "",
                    )
                    user.set_unusable_password()
                    user.save(using=DB)
                    counts["angelegt"] += 1
                    if invite and user.email:
                        transaction.on_commit(lambda pk=user.pk: _queue_invite(pk), using=DB)
                        counts["eingeladen"] += 1
                else:
                    counts["aktualisiert"] += 1
                link = ProgeoWerkUser(user=user, airtable_resource_id=resource["id"])
            if link.deactivated_by_sync and not user.is_active:
                user.is_active = True
                user.save(using=DB, update_fields=["is_active"])
            if resource["email"] and not user.email:
                user.email = resource["email"]
                user.save(using=DB, update_fields=["email"])
            user.groups.add(group)
            link.name = resource["name"]
            link.deactivated_by_sync = False
            link.synced_at = now
            link.save(using=DB)

        ticked = {resource["id"] for resource in resources}
        gone = ProgeoWerkUser.objects.using(DB).select_related("user").filter(
            airtable_resource_id__isnull=False).exclude(airtable_resource_id__in=ticked)
        for link in gone:
            user = link.user
            user.groups.remove(group)
            # Staff keep their account - only the factory right goes.
            if user.is_active and not user.is_staff and not user.is_superuser:
                user.is_active = False
                user.save(using=DB, update_fields=["is_active"])
                link.deactivated_by_sync = True
                link.save(using=DB, update_fields=["deactivated_by_sync"])
                counts["deaktiviert"] += 1
    ilog(f"Factory users synced: {counts}", tag="[WERK]")
    return counts
