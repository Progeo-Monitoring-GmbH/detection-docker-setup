"""Factory accounts (docs/fertigung.md 1a): who may use the /v1/werk/ endpoints, the
app's "who am I" and the sync of the Airtable "Ressourcen" with a ticked
"Werk-App" box into backend accounts (group "Werk", not staff).

- is_factory_user(): staff, superuser or group "Werk".
- me(): GET /v1/werk/ich/.
- sync(): `manage.py sync_werk_users`, celery (nightly), staff button - links
  existing accounts, creates the missing ones (no mail: invited by hand).
"""

import re
import unicodedata

from django.conf import settings
from django.contrib.auth.models import Group, User
from django.db import DEFAULT_DB_ALIAS, transaction
from django.db.models import Q
from django.utils import timezone

from progeo.helper.basics import ilog, wlog

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
    from progeo.werk.models import WerkUser

    return WerkUser.objects.using(DB).filter(user=user).first()


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


def split_name(name):
    """"Max von Muster" -> ("Max von", "Muster"); one word -> (word, "")."""
    words = str(name or "").split()
    if len(words) < 2:
        return (words[0] if words else ""), ""
    return " ".join(words[:-1])[:150], words[-1][:150]


INTERNAL_MAIL_DOMAIN = "@progeo.com"


def is_customer(user) -> bool:
    """A member of a customer account (portal user)."""
    return user.accounts.exists()


def is_internal(user) -> bool:
    """An account the sync may give the factory right: staff, superuser,
    already "Werk", or an own address without a customer account. A
    customer who happens to share a name must never get it."""
    if user.is_staff:
        return True
    if user.is_superuser:
        return True
    if user.groups.filter(name=GROUP).exists():
        return True
    return (user.email or "").lower().endswith(INTERNAL_MAIL_DOMAIN) and not is_customer(user)


def find_account(resource):
    """The existing internal account of a resource (is_internal), only an
    unambiguous hit: 1. the same address (case ignored), 2. the username the
    sync would give or the address before the "@" ("beispiel" for
    beispiel@…), 3. first + last name. Returns (user, how) - (None, None)
    for none, (None, why) if ambiguous or not internal (link it by hand)."""
    user, how = _match_account(resource)
    if user is not None and not is_internal(user):
        return None, f"Konto {user.username} ({how}) ist kein internes Konto"
    return user, how


def _match_account(resource):
    users = User.objects.using(DB)
    email, name = resource["email"], resource["name"]
    if email:
        hits = list(users.filter(email__iexact=email)[:2])
        if len(hits) == 1:
            return hits[0], "E-Mail"
        if len(hits) > 1:
            return None, f"mehrere Konten mit {email}"
    usernames = {make_username(email, name), make_username("", name)}
    if email:
        usernames.add(email.split("@", 1)[0].lower())
    same_username = Q()
    for username in usernames:
        same_username |= Q(username__iexact=username)
    hits = [user for user in users.filter(same_username)[:3]
            # A username match with another address is someone else.
            if not (email and user.email and user.email.lower() != email)]
    if len(hits) == 1:
        return hits[0], "Benutzername"
    if len(hits) > 1:
        return None, "mehrere Konten mit passendem Benutzernamen"
    first, last = split_name(name)
    if first and last:
        hits = list(users.filter(first_name__iexact=first, last_name__iexact=last)[:2])
        if len(hits) == 1:
            return hits[0], "Name"
        if len(hits) > 1:
            return None, f"mehrere Konten namens {name}"
    return None, None


class _DryRun(Exception):
    """Rolls a dry run back."""


def sync(helper=None, dry_run=False) -> dict:
    """Creates/links the accounts of the ticked resources, deactivates the
    ones no longer ticked. An existing account (find_account) is linked,
    never doubled. New accounts get no password and no mail - staff invite
    them by hand. `dry_run`: everything rolled back, the report stays.
    Returns the counts and "details" (one line per person)."""
    from progeo.helper.airtable import AirtableHelper
    from progeo.werk.models import WerkUser

    helper = helper or AirtableHelper()
    if not helper.configured:
        raise RuntimeError("Airtable is not configured")
    resources = fetch_resources(helper)
    report = {"angelegt": 0, "verknuepft": 0, "aktualisiert": 0, "deaktiviert": 0, "uebersprungen": 0,
              "details": []}

    def note(resource_name, username, action):
        report["details"].append({"name": resource_name, "benutzer": username, "aktion": action})

    try:
        with transaction.atomic(using=DB):
            _sync(resources, report, note, WerkUser)
            if dry_run:
                raise _DryRun
    except _DryRun:
        pass
    counts = {key: value for key, value in report.items() if key != "details"}
    ilog(f"Factory users synced{' (dry run)' if dry_run else ''}: {counts}", tag="[WERK]")
    return report


def _sync(resources, report, note, WerkUser):
    group, _created = Group.objects.using(DB).get_or_create(name=GROUP)
    now = timezone.now()
    for resource in resources:
        if not resource["name"]:
            report["uebersprungen"] += 1
            note("", None, f"übersprungen: {resource['id']} ohne Namen")
            continue
        link = WerkUser.objects.using(DB).select_related("user").filter(airtable_resource_id=resource["id"]).first()
        if link is not None:
            user, action = link.user, "aktualisiert"
        else:
            user, how = find_account(resource)
            if user is None and how:
                report["uebersprungen"] += 1
                note(resource["name"], None, f"übersprungen: {how} - bitte von Hand verknüpfen")
                continue
            if user is not None and WerkUser.objects.using(DB).filter(user=user).exists():
                report["uebersprungen"] += 1
                note(resource["name"], user.username, "übersprungen: Konto gehört schon zu einer anderen Ressource")
                wlog(f"Resource {resource['id']}: {user.username} is linked to another resource", tag="[WERK]")
                continue
            if user is None:
                first, last = split_name(resource["name"])
                user = User(username=_unique_username(make_username(resource["email"], resource["name"])),
                            email=resource["email"], first_name=first, last_name=last)
                user.set_unusable_password()
                user.save(using=DB)
                action = "angelegt (ohne Passwort, Einladung von Hand)"
            else:
                action = f"vorhandenes Konto verknüpft ({how})"
            link = WerkUser(user=user, airtable_resource_id=resource["id"])
        report["angelegt" if action.startswith("angelegt") else
               "verknuepft" if action.startswith("vorhanden") else "aktualisiert"] += 1
        changed = []
        if link.deactivated_by_sync and not user.is_active:
            user.is_active = True
            changed.append("is_active")
        if not user.first_name and not user.last_name:
            user.first_name, user.last_name = split_name(resource["name"])
            changed += ["first_name", "last_name"]
        if resource["email"] and not user.email and \
                not User.objects.using(DB).filter(email__iexact=resource["email"]).exclude(pk=user.pk).exists():
            user.email = resource["email"]
            changed.append("email")
        if changed:
            user.save(using=DB, update_fields=changed)
        user.groups.add(group)
        link.name = resource["name"]
        link.deactivated_by_sync = False
        link.synced_at = now
        link.save(using=DB)
        note(resource["name"], user.username, action)

    ticked = {resource["id"] for resource in resources}
    gone = WerkUser.objects.using(DB).select_related("user").filter(
        airtable_resource_id__isnull=False).exclude(airtable_resource_id__in=ticked)
    for link in gone:
        user = link.user
        if not user.groups.filter(pk=group.pk).exists() and not user.is_active:
            continue
        user.groups.remove(group)
        # Staff and customer accounts keep their account - only the factory right goes.
        if user.is_active and not user.is_staff and not user.is_superuser and not is_customer(user):
            user.is_active = False
            user.save(using=DB, update_fields=["is_active"])
            link.deactivated_by_sync = True
            link.save(using=DB, update_fields=["deactivated_by_sync"])
            report["deaktiviert"] += 1
            note(link.name, user.username, "deaktiviert (Haken entfernt)")
        else:
            note(link.name, user.username, "Werk-Recht entzogen (Konto bleibt aktiv)")
