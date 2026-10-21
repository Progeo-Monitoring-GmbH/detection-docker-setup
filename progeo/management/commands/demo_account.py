import datetime
import math
import os
import random
import secrets

from django.contrib.auth.models import Permission, User
from django.core.files.storage import FileSystemStorage
from django.core.management.base import CommandError
from django.db import connections, transaction
from django.utils import timezone

from progeo.helper.demo import (
    DEMO_ACCOUNT_HASH,
    DEMO_ACCOUNT_NAME,
    DEMO_LAGEPLAN_PREFIX_REL,
    DEMO_TOKEN_PURPOSE,
    DEMO_USER_PERMISSIONS,
    DEMO_USERNAME,
)
from progeo.helper.project_dbs import demo_alias, is_project_alias, register_demo_db
from progeo.management.commands._base import BaseCommand
from progeo.settings import DEMO_DATABASE, UPLOAD_DIR
from progeo.v1.models import (
    Account,
    LimitedToken,
    ProgeoAccess,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurement,
    ProgeoMeasurePoint,
    UserProfile,
)

DEFAULT_DB = DEMO_DATABASE
TOKEN_LIFETIME = datetime.timedelta(days=3650)

HISTORY_DAYS = 90  # measurements of the last ~3 months, hourly, ending now
BASE_LEVEL = 500  # eigenpotenzial; wirkpotenzial = eigen + sensor value
# Over-threshold measurements closer than this belong to one alarm (the demo
# noise must not split a moisture event into several alarms).
ALARM_MERGE_GAP = datetime.timedelta(hours=6)
LORAWAN_INTERVAL_MIN = 20  # uplink interval of the LoRaWAN climate sensors

PLAN_SIZE = (1600, 1200)
TYPES = ProgeoLocation.PROJECT_TYPE_CHOICES

PAPER = "#fbfaf6"
INK = "#3d4a57"
INK_SOFT = "#8b96a3"
LINE_SOFT = "#c9d1da"
ROOF_FILL = "#ffffff"
ZONE_FILL = "#f3f6f9"


def _grid(x_from, y_from, x_to, y_to, columns, rows, name=None, snake=False):
    """Sensors evenly spread over a rectangle of the plan (pixels), row by
    row: [(name, px, py, grid_x, grid_y)]. `snake` runs every second row
    backwards - one continuous cable run, as a DFH zone is drawn."""
    width, height = x_to - x_from, y_to - y_from
    return [
        (name, x_from + width * (col + 0.5) / columns, y_from + height * (row + 0.5) / rows, col, row)
        for row in range(rows)
        for col in (reversed(range(columns)) if snake and row % 2 else range(columns))
    ]


# --------------------------------------------------------------------- plans
# Every plan is drawn on PLAN_SIZE; the sensor positions below are pixels of
# that image, so nx/ny (= px / width, py / height) sit exactly on the drawing.

SMARTEX_ROOF = (160, 130, 1340, 850)  # 59 m x 36 m
SMARTEX_METERS = 59.0

DFH_ZONES = {  # name: rectangle; Hauptdach 3x2, Anbau and Garage 2x2 sensors
    "Hauptdach": ((180, 150, 920, 560), 3, 2),
    "Anbau": ((180, 620, 640, 930), 2, 2),
    "Garage": ((1000, 330, 1400, 700), 2, 2),
}
DFH_METERS_PER_PIXEL = 0.025

LORAWAN_BUILDING = (200, 460, 1100, 960)  # EG + KG, the roof sits on top
LORAWAN_GROUND_Y = 760
LORAWAN_METERS = 12.0
LORAWAN_ROOMS = {  # sensor label: centre of the room (pixels)
    "Keller": (650, 870),
    "Wohnzimmer": (475, 620),
    "Dachboden": (650, 365),
    "Bad": (925, 620),
}

# The one leak of each pair-based demo location, as multiples of the alarm
# threshold: `sensor` (sensor_order) shoots up within `rise_h` to `peak`, then
# sinks (exponentially, `decay_h`) towards `settle` and stays there. Every
# other sensor stays below DRY_MAX. Times count back from now.
# smartex: dry for days, sharp spike, declining - the alarm is over (the 7-day
# view shows all of it). DFH: started 3 days ago and still over the threshold
# - an open alarm.
DRY_MAX = 0.25
SMARTEX_LEAK = {"sensor": 13, "start_days_ago": 5, "rise_h": 2, "peak": 3.68, "settle": 0.75, "decay_h": 36,
                "status": ProgeoAlarm.Status.QUITTIERT, "rain": {"before_h": 5, "duration": 8, "amount": 21.6}}
DFH_LEAK = {"sensor": 8, "start_days_ago": 3, "rise_h": 3, "peak": 1.9, "settle": 1.45, "decay_h": 30,
            "status": ProgeoAlarm.Status.NEU, "rain": {"before_h": 3, "duration": 5, "amount": 14.2}}

# LoRaWAN climate sensors: share of uplinks lost on the radio link, battery
# percent used up over 90 days, calibration offset (degrees C, % RH).
LORAWAN_SENSORS = {
    "Keller": {"loss": 0.06, "drain": 9, "offset": (0.2, 1.5)},  # underground: weakest link
    "Wohnzimmer": {"loss": 0.01, "drain": 11, "offset": (-0.1, -0.8)},
    "Dachboden": {"loss": 0.02, "drain": 24, "offset": (0.3, 0.4)},  # heat drains the battery
    "Bad": {"loss": 0.025, "drain": 13, "offset": (0.0, 2.1)},
}

# People of the demo (usernames start with DEMO_PEOPLE_PREFIX; no password, no
# permissions - nobody can log in as them). "member": account members, they
# see every demo location, `rule` their notification rule there. "single:<kind>":
# access to that one location only. "partner": members of the demo partner
# account the demo user belongs to as well - the users the Rechte tab offers
# when granting access.
DEMO_PEOPLE_PREFIX = "demo."
DEMO_PARTNER_HASH = "demo-partner-account"
DEMO_PARTNER_NAME = "Demo Partner"
_ALARM = ProgeoAccess.NotifiTypes.ALARM
_ALARM_TIMEOUT = ProgeoAccess.NotifiTypes.ALARM | ProgeoAccess.NotifiTypes.TIMEOUT
DEMO_PEOPLE = [
    ("erika.mustermann", "Erika", "Mustermann", "+49 151 23456781", "member",
     ProgeoAccess.NotifiTrans.EMAIL_AND_SMS, _ALARM_TIMEOUT),
    ("max.mustermann", "Max", "Mustermann", "+49 151 23456782", "member", ProgeoAccess.NotifiTrans.EMAIL, _ALARM),
    ("jonas.weber", "Jonas", "Weber", "+49 160 9876541", "single:smartex", ProgeoAccess.NotifiTrans.SMS, _ALARM),
    ("sabine.krueger", "Sabine", "Krüger", "+49 160 9876542", "single:dfh", ProgeoAccess.NotifiTrans.EMAIL, _ALARM),
    ("lukas.hoffmann", "Lukas", "Hoffmann", None, "single:lorawan", ProgeoAccess.NotifiTrans.EMAIL, _ALARM),
    ("laura.fischer", "Laura", "Fischer", "+49 171 5550101", "partner", None, None),
    ("paul.wagner", "Paul", "Wagner", None, "partner", None, None),
    ("mia.becker", "Mia", "Becker", "+49 171 5550103", "partner", None, None),
    ("felix.schulz", "Felix", "Schulz", None, "partner", None, None),
]

# Every demo location is rebuilt on each run; `kind` also names the plan file.
LOCATIONS = [
    {
        "kind": "smartex",
        "name": "Demo Flachdach (smartex)",
        "project_type": TYPES.SMARTEX,
        "project_id": 9001,
        "address": "Musterstrasse 1",
        "city": "Musterstadt",
        "coordinates": (52.5306, 13.3846),
        "points": _grid(*SMARTEX_ROOF, 5, 5),
        "leak": SMARTEX_LEAK,
    },
    {
        "kind": "dfh",
        "name": "Demo Dachsanierung (DFH)",
        "project_type": TYPES.DFH,
        "project_id": 9002,
        "address": "Dorfweg 12",
        "city": "Beispieldorf",
        "coordinates": (52.4559, 13.2905),
        "points": [
            point for name, (rect, columns, rows) in DFH_ZONES.items()
            for point in _grid(*rect, columns, rows, name, snake=True)
        ],
        "leak": DFH_LEAK,
    },
    {
        "kind": "lorawan",
        "name": "Demo Gebaeude (LoRaWAN)",
        "project_type": TYPES.LORAWAN,
        "project_id": 9003,
        "address": "Sensorallee 3",
        "city": "Funkstadt",
        "coordinates": (52.5163, 13.4542),
        "points": [(label, x, y, index, 0) for index, (label, (x, y)) in enumerate(LORAWAN_ROOMS.items())],
    },
]


class Command(BaseCommand):
    help = (
        "Create (or reset) the demo account used by the public demo: an Account with a 'demo' user "
        "(read-only portal permissions, see helper/demo.py), a LimitedToken for the demo link and one "
        "demo location per device type (smartex: 25 sensors, DFH: 14 sensors in 3 roof zones, LoRaWAN: "
        "4 climate sensors), each with a drawn Lageplan, measure points on it, measurements of the "
        "last 3 months and the alarms they raise, plus a few demo people (colleagues, single-access "
        "users, partners to grant access to). The locations live in a separate database "
        "(default: settings.DEMO_DATABASE, 'demo'), so the demo never touches real customer data.\n"
        "Re-running resets the demo locations and shifts the timestamps to 'now'; account, user "
        "and the active demo link stay, so links handed out keep working.\n"
        "Demo links are never deleted: a replaced (--rotate-token) or retired (--delete) link is "
        "only disabled, so the usage of every link handed out stays countable (--links).\n\n"
        "Examples:\n"
        "  python manage.py demo_account\n"
        "  python manage.py demo_account --new-link --label 'Messe Hannover'\n"
        "  python manage.py demo_account --rotate-token\n"
        "  python manage.py demo_account --links\n"
        "  python manage.py demo_account --delete"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--database",
            default=DEFAULT_DB,
            help=f"Database alias that holds the demo data (default: {DEFAULT_DB}).",
        )
        parser.add_argument(
            "--delete",
            action="store_true",
            help="Remove the demo locations and plans and disable every demo link and the demo user. "
            "Account, user and links are kept for the usage history.",
        )
        links = parser.add_mutually_exclusive_group()
        links.add_argument(
            "--new-link",
            action="store_true",
            help="Only hand out an additional demo link (e.g. one per recipient); the active ones "
            "keep working. The demo data is not touched.",
        )
        links.add_argument(
            "--rotate-token",
            action="store_true",
            help="Only hand out a new demo link and disable every active one (kept for their "
            "usage history). The demo data is not touched.",
        )
        parser.add_argument(
            "--label",
            default="",
            help="Name of the link handed out with --new-link/--rotate-token, e.g. who got it (see --links).",
        )
        parser.add_argument(
            "--links",
            action="store_true",
            help="Only list every demo link with its status and how often it was opened.",
        )
        parser.add_argument(
            "--days",
            type=int,
            default=HISTORY_DAYS,
            help=f"Days of measurement history (default: {HISTORY_DAYS}).",
        )
        parser.add_argument(
            "--seed",
            type=int,
            default=1,
            help="Seed of the generated sensor noise (default: 1).",
        )

    def handle(self, *args, **options):
        if options["links"]:
            self._print_links()
            return
        if options["new_link"] or options["rotate_token"]:
            self._hand_out_link(rotate=options["rotate_token"], label=options["label"].strip())
            return
        if options["label"]:
            raise CommandError("--label only goes with --new-link or --rotate-token.")
        db = options["database"]
        if db == "default" or is_project_alias(db):
            raise CommandError(f"The demo data must not live in '{db}' (default or a project database).")
        if db == demo_alias():
            register_demo_db(create=True)  # created + migrated on the first run
        if db not in connections.databases:
            raise CommandError(f"Unknown database '{db}'. Configured: {', '.join(connections.databases)}")
        if options["days"] < 1:
            raise CommandError("--days must be at least 1.")

        with transaction.atomic(using="default"), transaction.atomic(using=db):
            account = Account.objects.using("default").filter(raw_hash=DEMO_ACCOUNT_HASH).first()
            if account is not None:
                self._remove_locations(account, db)

            if options["delete"]:
                self._retire_account(account)
                self.stdout.write(self.style.SUCCESS(
                    f"Demo removed from '{db}': locations deleted, demo links and user disabled "
                    "(kept for the usage history, see --links)."
                ))
                return

            account = self._ensure_account(account, db)
            user = self._ensure_user(account)
            tokens = self._ensure_tokens(account, user)

            rng = random.Random(options["seed"])
            now = timezone.now().replace(minute=0, second=0, microsecond=0)
            hours = options["days"] * 24
            created = [self._create_location(account, db, spec, rng, now, hours) for spec in LOCATIONS]
            self._ensure_people(account, user, db, dict(zip((spec["kind"] for spec in LOCATIONS), created)))

        summary = ", ".join(f"{spec['kind']}={location.pk}" for spec, location in zip(LOCATIONS, created))
        self.stdout.write(
            self.style.SUCCESS(f"Demo account ready: db={db}, account_id={account.pk}, locations: {summary}")
        )
        for token in tokens:
            self.stdout.write(_link_line(token))

    # ------------------------------------------------------------------ cleanup

    def _remove_locations(self, account, db):
        """Delete the demo locations; the cascade takes devices, measurements,
        points, alarms and plan rows along. Their plan files are removed as
        well - only theirs: other databases' demo plans (e.g. the tests' and
        the dev server's) share the upload folder."""
        files = [
            name
            for name in ProgeoLageplan.objects.using(db)
            .filter(location__account_id=account.pk)
            .values_list("lageplan", flat=True)
            if name and name.startswith(DEMO_LAGEPLAN_PREFIX_REL)
        ]
        ProgeoLocation.objects.using(db).filter(account_id=account.pk).delete()
        for name in files:
            path = os.path.join(UPLOAD_DIR, name)
            try:
                if os.path.isfile(path):
                    os.remove(path)
            except OSError as error:  # e.g. held open by a running server (Windows)
                self.stderr.write(f"Could not remove the old plan {path}: {error}")

    def _retire_account(self, account):
        """--delete: no demo link may work anymore, but none is deleted - the
        links cascade with their account and user, so both stay (the user
        inactive). The next run without --delete hands out a new link."""
        if account is None:
            return
        _disable_links(LimitedToken.objects.using("default").filter(account=account, purpose=DEMO_TOKEN_PURPOSE))
        User.objects.using("default").filter(username=DEMO_USERNAME, accounts=account).update(is_active=False)
        User.objects.using("default").filter(username__startswith=DEMO_PEOPLE_PREFIX).update(is_active=False)

    def _print_links(self):
        """Every demo link ever handed out, newest first, with its usage."""
        tokens = LimitedToken.objects.using("default").filter(purpose=DEMO_TOKEN_PURPOSE).order_by("-created")
        if not tokens:
            self.stdout.write("No demo links yet.")
            return
        for token in tokens:
            self.stdout.write(_link_line(token))

    # ------------------------------------------------------------------- access

    def _ensure_account(self, account, db):
        """Account metadata lives in 'default'; the demo database needs a copy
        with the same pk because its locations reference the account."""
        if account is None:
            shared = _same_database(db)
            # The pk must be free in both databases. The sequences of 'default'
            # and the demo database drift apart, so skip (burn) pks that are
            # taken over there; sequence values are never rolled back.
            for _ in range(1000):
                account = Account.objects.using("default").create(
                    raw_hash=DEMO_ACCOUNT_HASH, name=DEMO_ACCOUNT_NAME, db_name=db
                )
                if shared or not Account.objects.using(db).filter(pk=account.pk).exists():
                    break
                account.delete(using="default")
            else:
                raise CommandError(f"Could not find an account pk that is free in '{db}'.")

        if account.db_name != db:
            account.db_name = db
            account.save(using="default")
        if not _same_database(db) and not Account.objects.using(db).filter(pk=account.pk).exists():
            Account.objects.using(db).create(
                pk=account.pk, raw_hash=DEMO_ACCOUNT_HASH, name=DEMO_ACCOUNT_NAME, db_name=db
            )
        return account

    def _ensure_user(self, account):
        """A non-staff user that is a member of the demo account and holds the
        read-only portal permissions of DEMO_USER_PERMISSIONS - and nothing else.
        Every write of this user is refused by DemoReadOnlyMiddleware."""
        user, _ = User.objects.using("default").get_or_create(
            username=DEMO_USERNAME, defaults={"is_staff": False, "is_superuser": False}
        )
        user.is_staff = False
        user.is_superuser = False
        user.is_active = True
        user.first_name = "Demo"
        user.last_name = "Benutzer"
        user.email = "demo@example.com"
        user.set_unusable_password()
        user.save(using="default")

        permissions = list(
            Permission.objects.using("default").filter(
                content_type__app_label="progeo", codename__in=DEMO_USER_PERMISSIONS
            )
        )
        missing = set(DEMO_USER_PERMISSIONS) - {permission.codename for permission in permissions}
        if missing:
            raise CommandError(
                f"Permissions {sorted(missing)} are missing - run 'manage.py migrate' first."
            )
        user.user_permissions.set(permissions)
        user.groups.clear()
        account.users.add(user)
        return user

    def _ensure_people(self, account, demo_user, db, locations):
        """DEMO_PEOPLE: users in "default" (where logins and memberships
        live), mirrored into the demo database - its ProgeoAccess rows
        reference them there - plus their access/notification rules, which
        went with the old locations."""
        partner, _ = Account.objects.using("default").get_or_create(
            raw_hash=DEMO_PARTNER_HASH, defaults={"name": DEMO_PARTNER_NAME, "db_name": db}
        )
        if partner.db_name != db:
            partner.db_name = db
            partner.save(using="default")
        partner.users.add(demo_user)

        rules = []
        for name, first, last, mobile, role, transport, notify in DEMO_PEOPLE:
            username = f"{DEMO_PEOPLE_PREFIX}{name}"
            person, _ = User.objects.using("default").get_or_create(username=username)
            person.first_name, person.last_name = first, last
            person.email = f"{name}@example.com"
            person.is_staff = person.is_superuser = False
            person.is_active = True
            person.set_unusable_password()
            person.save(using="default")
            person.user_permissions.clear()
            if mobile:
                UserProfile.objects.using("default").update_or_create(user_id=person.pk, defaults={"mobile": mobile})
            else:
                UserProfile.objects.using("default").filter(user_id=person.pk).delete()

            account.users.remove(person)
            partner.users.remove(person)
            if role == "member":
                account.users.add(person)
                targets = list(locations.values())
            elif role == "partner":
                partner.users.add(person)
                targets = []
            else:
                targets = [locations[role.split(":", 1)[1]]]

            if not _same_database(db):
                User.objects.using(db).update_or_create(
                    pk=person.pk,
                    defaults={"username": username, "email": person.email, "first_name": first,
                              "last_name": last, "password": person.password, "is_active": True},
                )
            rules.extend(
                ProgeoAccess(location=location, user_id=person.pk, transport=transport, type=notify)
                for location in targets
            )
        ProgeoAccess.objects.using(db).bulk_create(rules)

    def _ensure_tokens(self, account, user):
        """Every active demo link stays valid (several can be handed out, see
        --new-link); the first run creates one. Disabled links are never
        enabled again. Returns the active links, newest first."""
        active = LimitedToken.objects.using("default").filter(
            account=account, purpose=DEMO_TOKEN_PURPOSE, disabled=False
        )
        if not active.exists():
            _create_link(account, user)
        active.update(user_id=user.pk, valid_until=timezone.now() + TOKEN_LIFETIME)
        return list(active.order_by("-created", "-pk"))

    def _hand_out_link(self, rotate, label):
        """--new-link / --rotate-token: a new demo link for the existing demo,
        without touching its data (visitors may be looking at it)."""
        account = Account.objects.using("default").filter(raw_hash=DEMO_ACCOUNT_HASH).first()
        user = User.objects.using("default").filter(
            username=DEMO_USERNAME, accounts=account, is_active=True
        ).first() if account else None
        if user is None:
            raise CommandError("There is no demo (or it was removed) - run 'manage.py demo_account' first.")
        with transaction.atomic(using="default"):
            active = LimitedToken.objects.using("default").filter(
                account=account, purpose=DEMO_TOKEN_PURPOSE, disabled=False
            )
            disabled = _disable_links(active) if rotate else 0
            token = _create_link(account, user, label)
        if disabled:
            self.stdout.write(f"{disabled} earlier demo link(s) disabled (kept, see --links).")
        self.stdout.write(self.style.SUCCESS("New demo link:"))
        self.stdout.write(_link_line(token))

    # --------------------------------------------------------------- locations

    def _create_location(self, account, db, spec, rng, now, hours):
        latitude, longitude = spec["coordinates"]
        location = ProgeoLocation.objects.using(db).create(
            account=account,
            name=spec["name"],
            address=spec["address"],
            plz="12345",
            city=spec["city"],
            country="Deutschland",
            manager="Max Mustermann",
            contact_person="Erika Mustermann",
            latitude=latitude,
            longitude=longitude,
            project_id=spec["project_id"],
            project_type=spec["project_type"],
        )
        plan = self._create_lageplan(location, db, spec)
        points = self._create_points(location, plan, db, spec["points"])
        if spec["project_type"] == TYPES.LORAWAN:
            self._create_climate_data(location, db, spec, rng, now, hours)
        else:
            device = self._create_device(location, db, f"demo-device-{spec['kind']}", f"Demo-Device {spec['kind']}")
            measurements = self._create_measurements(device, db, spec, rng, now, hours)
            newest = measurements[-1].get_pairs() if measurements else []
            for point in points:
                if point.sensor_order <= len(newest):
                    point.last_value = newest[point.sensor_order - 1]
            ProgeoMeasurePoint.objects.using(db).bulk_update(points, ["last_value"])
            self._create_alarms(measurements, location, db, spec["leak"])
        return location

    def _create_device(self, location, db, raw_hash, label, device_type=ProgeoDevice.DeviceType.SMARTBOX):
        return ProgeoDevice.objects.using(db).create(
            location=location,
            raw_hash=raw_hash,
            type=device_type,
            hardware=label,
            mac=label,
            version="demo",
            project_id=location.project_id,
            has_internet=True,
            data_interval=3600,
        )

    def _create_points(self, location, plan, db, points):
        width, height = PLAN_SIZE
        return ProgeoMeasurePoint.objects.using(db).bulk_create(
            ProgeoMeasurePoint(
                location=location,
                lageplan=plan,
                name=name,
                sensor_order=order,
                x=px,
                y=py,
                nx=px / width,
                ny=py / height,
                grid_x=grid_x,
                grid_y=grid_y,
                threshold=location.alarm_threshold,
            )
            for order, (name, px, py, grid_x, grid_y) in enumerate(points, start=1)
        )

    # ------------------------------------------------------- pair measurements

    def _create_measurements(self, device, db, spec, rng, now, hours):
        """Hourly pair measurements: a dry roof - every sensor with its own
        base level, a small daily swing and noise, always below DRY_MAX of the
        threshold - except the leak of spec["leak"] (_leak_level)."""
        points = spec["points"]
        leak = spec["leak"]
        threshold = device.location.alarm_threshold
        dry_max = DRY_MAX * threshold - 1
        base = [rng.uniform(0.06, 0.15) * threshold for _ in points]
        eigen = [BASE_LEVEL + rng.randint(-25, 25) for _ in points]

        measurements = []
        for hours_ago in range(hours - 1, -1, -1):
            fetched = now - datetime.timedelta(hours=hours_ago) + datetime.timedelta(seconds=rng.randint(0, 90))
            daily = math.sin(2 * math.pi * (fetched.hour - 9) / 24)
            season = hours_ago / max(hours - 1, 1)  # 1 = oldest (summer), 0 = now
            leak_level = _leak_level(leak, hours_ago)
            wet = leak_level is not None and leak_level > 1  # damp air while the leak is over threshold

            values = []
            for index in range(len(points)):
                value = base[index] + 0.02 * threshold * daily + rng.gauss(0, 0.012 * threshold)
                value = min(max(value, 0), dry_max)
                if index == leak["sensor"] - 1 and leak_level is not None:
                    value = max(value, leak_level * threshold * (1 + rng.gauss(0, 0.01)))
                values.append(round(value))

            measurements.append(
                ProgeoMeasurement(
                    device=device,
                    project_id=device.project_id,
                    temperature=round(13 + 9 * season + 4 * daily + rng.uniform(-0.4, 0.4), 1),
                    humidity=round(min(98, 62 - 10 * season - 8 * daily + 6 * wet + rng.uniform(-2, 2)), 1),
                    eigenpotenzial=eigen,
                    wirkpotenzial=[level + value for level, value in zip(eigen, values)],
                    raw_data={},
                    last_fetched=fetched,
                    last_updated=fetched,
                )
            )
        # bulk_create skips save(), which would overwrite last_fetched with now;
        # created oldest first, so the pk order stays chronological.
        return ProgeoMeasurement.objects.using(db).bulk_create(measurements, batch_size=2000)

    def _create_alarms(self, measurements, location, db, leak):
        """The alarm of the leak, derived from the generated values the way
        the alarm evaluation does it: over-threshold measurements of the
        device form an episode, the first one below normalizes it."""
        threshold = location.alarm_threshold
        found = []
        current = None
        for measurement in measurements:
            over = measurement.evaluate_all(threshold)
            at = measurement.last_fetched
            if not over:
                if current is not None and current["normalized_at"] is None:
                    current["normalized_at"] = at
                continue
            if current is None or (
                current["normalized_at"] is not None and at - current["normalized_at"] > ALARM_MERGE_GAP
            ):
                if current is not None:
                    found.append(current)
                current = {"measurements": [], "peaks": {}, "history": [], "normalized_at": None}
            current["normalized_at"] = None
            current["measurements"].append(measurement)
            for index, value in over:
                current["peaks"][index + 1] = max(current["peaks"].get(index + 1, 0), value)
            peak_index, peak_value = max(over, key=lambda pair: pair[1])
            current["history"].append({"ts": at.isoformat(), "value": float(peak_value), "sensor_id": peak_index + 1})
        if current is not None:
            found.append(current)

        for event in found:
            first, last = event["measurements"][0], event["measurements"][-1]
            sensor_id, peak = max(event["peaks"].items(), key=lambda item: item[1])
            status = leak["status"]
            if event["normalized_at"] is None and status == ProgeoAlarm.Status.GELOEST:
                status = ProgeoAlarm.Status.NEU  # still active, can't be resolved
            elif event["normalized_at"] is not None and status == ProgeoAlarm.Status.NEU:
                status = ProgeoAlarm.Status.GELOEST  # normalized, never acknowledged
            rain = leak.get("rain")
            ProgeoAlarm.objects.using(db).create(
                measurement=last,
                triggered_at=first.last_fetched,
                still_active_at=last.last_fetched,
                normalized_at=event["normalized_at"],
                threshold=threshold,
                sensor_id=sensor_id,
                max_value=float(peak),
                sensor_max_values=[
                    {"sensor_id": sensor, "max_value": float(value)} for sensor, value in sorted(event["peaks"].items())
                ],
                max_values=event["history"],
                evaluated_at=(
                    first.last_fetched + datetime.timedelta(hours=2)
                    if status == ProgeoAlarm.Status.QUITTIERT else None
                ),
                status=status,
                rain_events=[{
                    "start": (first.last_fetched - datetime.timedelta(hours=rain["before_h"])).isoformat(),
                    "duration": rain["duration"],
                    "amount": rain["amount"],
                }] if rain else [],
                # Checked already, so no weather lookup is ever made for demo alarms.
                rain_checked=True,
            )

    # ------------------------------------------------------------ climate data

    def _create_climate_data(self, location, db, spec, rng, now, hours):
        """LoRaWAN climate sensors as they really report: an uplink every
        LORAWAN_INTERVAL_MIN minutes (own phase, some jitter), lost packets
        and two gateway outages, sensor noise, calibration offsets, 0.1
        resolution and a slowly draining battery. The rooms follow the
        weather (_Weather) with their own inertia, see _Room."""
        devices = []
        for number, (label, *_position) in enumerate(spec["points"], start=1):
            device = self._create_device(
                location, db, f"DEMO{location.project_id}{number:04d}", label, ProgeoDevice.DeviceType.LORAWAN
            )
            device.hardware = f"{location.project_id}_S{number}"
            device.save(using=db)
            sensor = LORAWAN_SENSORS[label]
            devices.append((device, _Room(label, rng), sensor, rng.uniform(0, LORAWAN_INTERVAL_MIN)))

        start = now - datetime.timedelta(hours=hours)
        weather = _Weather(start, hours, rng)
        outages = [
            (start + datetime.timedelta(hours=rng.uniform(0, hours - 12)), datetime.timedelta(hours=rng.uniform(2, 8)))
            for _ in range(2)
        ]
        step = datetime.timedelta(minutes=LORAWAN_INTERVAL_MIN)
        steps = hours * 60 // LORAWAN_INTERVAL_MIN
        measurements = []
        for index in range(steps):
            at = start + index * step
            conditions = weather.at(at)
            for device, room, sensor, phase in devices:
                temperature, humidity = room.step(at, conditions, LORAWAN_INTERVAL_MIN / 60)
                fetched = at + datetime.timedelta(minutes=phase, seconds=rng.gauss(0, 25))
                if rng.random() < sensor["loss"] or any(begin <= fetched < begin + length for begin, length in outages):
                    continue
                temperature += sensor["offset"][0] + rng.gauss(0, 0.08)
                humidity += sensor["offset"][1] + rng.gauss(0, 0.6)
                used = sensor["drain"] * (index / steps) ** 1.15
                cold = 0.15 * max(0.0, 12 - temperature)  # the cell's voltage sags in the cold
                measurements.append(
                    ProgeoMeasurement(
                        device=device,
                        project_id=location.project_id,
                        temperature=round(temperature, 1),
                        humidity=round(min(99.9, max(5.0, humidity)), 1),
                        battery=float(min(100, max(0, round(100 - used - cold + rng.gauss(0, 0.4))))),
                        raw_data={},
                        last_fetched=fetched,
                        last_updated=fetched,
                    )
                )
        measurements.sort(key=lambda measurement: measurement.last_fetched)  # pk order = time order
        ProgeoMeasurement.objects.using(db).bulk_create(measurements, batch_size=2000)

    # ---------------------------------------------------------------- lageplan

    def _create_lageplan(self, location, db, spec):
        """A generated site plan, stored like an upload but under the demo_
        prefix the media view allows demo users to fetch. It is calibrated
        (reference point + meters per pixel), so positions show in meters."""
        from io import BytesIO

        from django.core.files.base import ContentFile

        drawing = {"smartex": _draw_smartex, "dfh": _draw_dfh, "lorawan": _draw_lorawan}[spec["kind"]]
        plan = _Plan()
        reference, meters_per_pixel = drawing(plan)
        plan.title_block(spec["name"], f"{spec['address']}, 12345 {spec['city']}")
        for order, (_name, px, py, _gx, _gy) in enumerate(spec["points"], start=1):
            plan.sensor_mark(px, py, f"{'S' if spec['kind'] == 'lorawan' else 'MP '}{order}")

        buffer = BytesIO()
        plan.image.save(buffer, format="PNG", optimize=True)

        os.makedirs(os.path.join(UPLOAD_DIR, os.path.dirname(DEMO_LAGEPLAN_PREFIX_REL)), exist_ok=True)
        stored = FileSystemStorage(location=UPLOAD_DIR).save(
            f"{DEMO_LAGEPLAN_PREFIX_REL}{spec['kind']}.png", ContentFile(buffer.getvalue(), name=f"{spec['kind']}.png")
        )
        return ProgeoLageplan.objects.using(db).create(
            location=location,
            lageplan=stored,
            name=f"{spec['name']} (Demo)",
            is_active=True,
            reference_x=reference[0],
            reference_y=reference[1],
            meters_per_pixel=meters_per_pixel,
        )


# ------------------------------------------------------------------- helpers


def _smooth(fraction):
    fraction = min(1.0, max(0.0, fraction))
    return fraction * fraction * (3 - 2 * fraction)


def _create_link(account, user, label=""):
    return LimitedToken.objects.using("default").create(
        raw_hash=secrets.token_urlsafe(32),
        raw_data={"label": label} if label else {},
        user_id=user.pk,
        account_id=account.pk,
        purpose=DEMO_TOKEN_PURPOSE,
        valid_until=timezone.now() + TOKEN_LIFETIME,
    )


def _disable_links(tokens):
    """Disable demo links, noting when - the rows stay for their usage.
    Returns how many were disabled."""
    disabled_at = timezone.now().isoformat()
    count = 0
    for token in tokens.filter(disabled=False):
        token.disabled = True
        token.raw_data = {**(token.raw_data or {}), "disabled_at": disabled_at}
        token.save(using="default", update_fields=["disabled", "raw_data"])
        count += 1
    return count


def _link_line(token):
    """One demo link with its label, status and usage (--links and the summaries)."""
    data = token.raw_data or {}
    status = "active" if not token.disabled else f"disabled {data.get('disabled_at', '')[:16]}".strip()
    label = data.get("label") or "-"
    last = (data.get("last_opened_at") or "never")[:16]
    return (
        f"{token.created:%Y-%m-%d %H:%M}  {label[:24]:<24}  {status:<27}  opened {token.check_counter:>5}x  "
        f"last {last:<16}  /demo/login/{token.raw_hash}"
    )


def _leak_level(leak, hours_ago):
    """The leak sensor's value as a multiple of the threshold `hours_ago`
    hours before now: a quick rise to the peak, then an exponential decline
    to `settle`. None before the leak started."""
    elapsed = leak["start_days_ago"] * 24 - hours_ago
    if elapsed < 0:
        return None
    if elapsed < leak["rise_h"]:
        return leak["peak"] * _smooth(elapsed / leak["rise_h"])
    decayed = math.exp(-(elapsed - leak["rise_h"]) / leak["decay_h"])
    return leak["settle"] + (leak["peak"] - leak["settle"]) * decayed


def _saturation(temperature):
    """Saturation vapour pressure (hPa, Magnus formula)."""
    return 6.112 * math.exp(17.62 * temperature / (243.12 + temperature))


def _relative_humidity(temperature, dew_point):
    return 100 * _saturation(min(dew_point, temperature)) / _saturation(temperature)


class _Weather:
    """Outside conditions of the demo period: the seasonal mean of the real
    calendar dates plus multi-day warm/cold spells and cloudy/sunny days
    (smooth random walks, one value per day, interpolated)."""

    def __init__(self, start, hours, rng):
        self.start = start
        days = hours // 24 + 3
        self.anomaly, self.cloud = [rng.gauss(0, 2)], [rng.random()]
        for _ in range(days):
            self.anomaly.append(0.75 * self.anomaly[-1] + rng.gauss(0, 1.8))
            self.cloud.append(min(1.0, max(0.0, 0.55 * self.cloud[-1] + 0.45 * rng.random() + rng.gauss(0, 0.1))))

    def _daily(self, series, day):
        index = int(day)
        return series[index] + (series[index + 1] - series[index]) * (day - index)

    def at(self, at):
        day = (at - self.start).total_seconds() / 86400
        # With USE_TZ off (production settings) the times are naive and
        # already local; localtime() only takes aware ones.
        local = timezone.localtime(at) if timezone.is_aware(at) else at
        hour = local.hour + local.minute / 60
        seasonal = 10 + 9 * math.cos(2 * math.pi * (local.timetuple().tm_yday - 200) / 365)
        mean = seasonal + self._daily(self.anomaly, day)
        cloud = self._daily(self.cloud, day)
        swing = (3 + 5 * (1 - cloud)) * math.sin(2 * math.pi * (hour - 9) / 24)
        return {
            "mean": mean,
            "temperature": mean + swing,
            "dew_point": mean - 1.5 - 5 * (1 - cloud),
            "sun": (1 - cloud) * max(0.0, math.sin(math.pi * (hour - 7) / 12)),
            "hour": hour,
            "day": int(day),
        }


class _Room:
    """Temperature and dew point of one room, following the weather with the
    room's own inertia (first-order lag) and its own events: heating with a
    night setback once it gets cold, airing, showers, sun on the attic, a
    cellar getting damp over the last three weeks."""

    def __init__(self, label, rng):
        self.label, self.rng = label, rng
        self.temperature = None
        self.dew_point = None
        self.events = {}  # day -> [(start hour, kind)]

    def _events_of(self, day):
        if day not in self.events:
            rng, events = self.rng, []
            if self.label in ("Wohnzimmer", "Bad") and rng.random() < 0.8:
                events.append((rng.uniform(7, 9.5), "airing"))
            if self.label == "Wohnzimmer" and rng.random() < 0.5:
                events.append((rng.uniform(17, 21), "airing"))
            if self.label == "Bad":
                if rng.random() < 0.85:
                    events.append((rng.uniform(6.3, 7.8), "shower"))
                if rng.random() < 0.35:
                    events.append((rng.uniform(19, 22.5), "shower"))
            self.events[day] = events
        return self.events[day]

    def _active(self, conditions, kind, minutes):
        hour = conditions["hour"]
        return any(
            event == kind and start <= hour < start + minutes / 60
            for start, event in self._events_of(conditions["day"])
        )

    def step(self, at, conditions, hours):
        outside, dew_outside = conditions["temperature"], conditions["dew_point"]
        heating = conditions["mean"] < 14
        hour = conditions["hour"]
        if self.label == "Keller":
            target, tau = 0.25 * conditions["mean"] + 0.75 * 12.5, 72
            # Damp over the last three weeks: the dew point creeps up.
            weeks = (timezone.now() - at).total_seconds() / (7 * 86400)
            dew_target, dew_tau = 0.3 * dew_outside + 0.7 * 7 + 3 * _smooth(1 - weeks / 3), 24
        elif self.label == "Dachboden":
            target, tau = outside + 2.5 + 15 * conditions["sun"], 2.5  # the roof keeps some warmth at night
            dew_target, dew_tau = dew_outside - 1, 3
        else:
            setpoint = (21.5 if 6 <= hour < 22 else 18.5) + (1 if self.label == "Bad" else 0)
            free = 0.35 * conditions["mean"] + 15 + 2.5 * conditions["sun"]
            target = max(setpoint, free) if heating else min(free, 27)
            tau = 1.5 if heating and (self.temperature or 0) < setpoint else 9
            dew_target = dew_outside + 2 + (2 if self.label == "Wohnzimmer" and 18 <= hour < 20 else 0)
            dew_tau = 1.5
            if self._active(conditions, "airing", 25):
                target, tau = outside, 0.6
                dew_target, dew_tau = dew_outside, 0.3
            if self._active(conditions, "shower", 25):
                target, tau = (self.temperature or target) + 2.5, 0.5
                dew_target, dew_tau = (self.temperature or target) + 1, 0.15
        if self.temperature is None:
            self.temperature, self.dew_point = target, dew_target
        self.temperature += (target - self.temperature) * min(1.0, hours / tau)
        self.dew_point += (dew_target - self.dew_point) * min(1.0, hours / dew_tau)
        self.dew_point = min(self.dew_point, self.temperature)
        return self.temperature, _relative_humidity(self.temperature, self.dew_point)


class _Plan:
    """A plain technical drawing (PIL) of PLAN_SIZE. Pillow's built-in font
    has no umlauts, hence the ASCII spelling of the labels."""

    def __init__(self):
        from PIL import Image, ImageDraw

        self.image = Image.new("RGB", PLAN_SIZE, PAPER)
        self.draw = ImageDraw.Draw(self.image)
        width, height = PLAN_SIZE
        self.draw.rectangle([24, 24, width - 24, height - 24], outline=INK_SOFT, width=2)

    @staticmethod
    def font(size):
        from PIL import ImageFont

        try:
            return ImageFont.load_default(size=size)
        except TypeError:  # Pillow without FreeType: the fixed bitmap font
            return ImageFont.load_default()

    def text(self, x, y, text, size=18, fill=INK, center=False):
        font = self.font(size)
        if center:
            left, top, right, bottom = self.draw.textbbox((0, 0), text, font=font)
            x, y = x - (right - left) / 2 - left, y - (bottom - top) / 2 - top
        self.draw.text((x, y), text, fill=fill, font=font)

    def hatch(self, box, color=LINE_SOFT, spacing=14, fill=None):
        """Diagonal hatching inside box (skylights, soil)."""
        from PIL import Image, ImageDraw

        x1, y1, x2, y2 = (int(value) for value in box)
        width, height = x2 - x1, y2 - y1
        tile = Image.new("RGB", (width, height), fill or PAPER)
        tile_draw = ImageDraw.Draw(tile)
        for offset in range(-height, width, spacing):
            tile_draw.line([offset, height, offset + height, 0], fill=color, width=1)
        self.image.paste(tile, (x1, y1))

    def dimension(self, start, end, label, vertical=False):
        """Dimension line with end ticks; `start`/`end` are (x, y)."""
        self.draw.line([start, end], fill=INK_SOFT, width=1)
        for x, y in (start, end):
            if vertical:
                self.draw.line([x - 8, y, x + 8, y], fill=INK_SOFT, width=1)
            else:
                self.draw.line([x, y - 8, x, y + 8], fill=INK_SOFT, width=1)
        middle_x, middle_y = (start[0] + end[0]) / 2, (start[1] + end[1]) / 2
        if vertical:  # label left of the line, right-aligned to it
            left, _top, right, _bottom = self.draw.textbbox((0, 0), label, font=self.font(16))
            self.text(middle_x - 12 - (right - left), middle_y - 9, label, size=16, fill=INK_SOFT)
        else:
            self.text(middle_x, middle_y - 16, label, size=16, fill=INK_SOFT, center=True)

    def north_arrow(self, x, y):
        self.draw.polygon([(x, y - 34), (x - 13, y + 12), (x, y + 2), (x + 13, y + 12)], outline=INK, fill=INK)
        self.text(x, y + 30, "N", size=18, center=True)

    def sensor_mark(self, x, y, label):
        self.draw.line([x - 9, y, x + 9, y], fill=INK_SOFT, width=2)
        self.draw.line([x, y - 9, x, y + 9], fill=INK_SOFT, width=2)
        self.text(x + 10, y + 6, label, size=14, fill=INK_SOFT)

    def dashed_rectangle(self, box, dash=20, gap=16):
        x1, y1, x2, y2 = box
        for start in range(x1, x2, dash + gap):
            for y in (y1, y2):
                self.draw.line([start, y, min(start + dash, x2), y], fill=INK_SOFT, width=2)
        for start in range(y1, y2, dash + gap):
            for x in (x1, x2):
                self.draw.line([x, start, x, min(start + dash, y2)], fill=INK_SOFT, width=2)

    def title_block(self, title, address):
        width, height = PLAN_SIZE
        box = (width - 470, height - 150, width - 40, height - 40)
        self.draw.rectangle(box, outline=INK, width=2, fill=PAPER)
        self.draw.line([box[0], box[1] + 44, box[2], box[1] + 44], fill=INK, width=1)
        self.text(box[0] + 16, box[1] + 11, title, size=20)
        self.text(box[0] + 16, box[1] + 56, address, size=15, fill=INK_SOFT)
        self.text(box[0] + 16, box[1] + 80, "Lageplan Messpunkte - Demo, nicht massstaeblich", size=13, fill=INK_SOFT)


def _meters(pixels, meters_per_pixel):
    return f"{pixels * meters_per_pixel:.2f} m".replace(".", ",")


def _draw_smartex(plan):
    """Flat roof of a hall: parapet, skylights, roof drains, an HVAC unit."""
    x1, y1, x2, y2 = SMARTEX_ROOF
    draw = plan.draw
    draw.rectangle([x1 - 12, y1 - 12, x2 + 12, y2 + 12], outline=INK, width=4, fill=ROOF_FILL)  # Attika
    draw.rectangle([x1, y1, x2, y2], outline=LINE_SOFT, width=2)
    # Skylights (Lichtkuppeln), HVAC unit and drains sit between the sensor
    # rows (y 202/346/490/634/778) and columns (x 278/514/750/986/1222).
    for cx, cy in ((632, 274), (1104, 562)):
        plan.hatch((cx - 44, cy - 26, cx + 44, cy + 26), fill=ZONE_FILL)
        draw.rectangle([cx - 44, cy - 26, cx + 44, cy + 26], outline=INK, width=2)
    draw.rectangle([336, 670, 456, 742], outline=INK, width=2, fill=ZONE_FILL)
    plan.text(396, 706, "RLT", size=16, center=True)
    for cx, cy in ((396, 418), (868, 418), (632, 562), (1104, 706)):  # Gullys
        draw.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], outline=INK, width=2)
        draw.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=INK)
    plan.text(1104, 736, "Gefaelle 2 %", size=14, fill=INK_SOFT, center=True)
    plan.text(x1 + 4, y1 - 46, "Halle A - Flachdach, Kunststoffbahn", size=20)
    meters_per_pixel = SMARTEX_METERS / (x2 - x1)
    plan.dimension((x1, y2 + 60), (x2, y2 + 60), _meters(x2 - x1, meters_per_pixel))
    plan.dimension((x1 - 60, y1), (x1 - 60, y2), _meters(y2 - y1, meters_per_pixel), vertical=True)
    plan.north_arrow(1480, 110)
    return (x1, y2), meters_per_pixel


def _draw_dfh(plan):
    """A house with annex and garage, the three roof zones of the DFH sensors."""
    draw = plan.draw
    plan.dashed_rectangle((60, 70, PLAN_SIZE[0] - 60, 990))  # property line
    plan.text(620, 1020, "Dorfweg", size=20, fill=INK_SOFT, center=True)
    for name, ((x1, y1, x2, y2), _columns, _rows) in DFH_ZONES.items():
        draw.rectangle([x1, y1, x2, y2], outline=INK, width=4, fill=ROOF_FILL)
        draw.rectangle([x1 + 10, y1 + 10, x2 - 10, y2 - 10], outline=LINE_SOFT, width=1)
        plan.text(x1 + 18, y1 + 18, name, size=20)
    # Driveway to the garage.
    plan.hatch((1080, 700, 1320, 990), fill=ZONE_FILL, spacing=22)
    draw.rectangle([1080, 700, 1320, 990], outline=LINE_SOFT, width=1)
    x1, y1, x2, _y2 = DFH_ZONES["Hauptdach"][0]
    plan.dimension((x1, y1 - 40), (x2, y1 - 40), _meters(x2 - x1, DFH_METERS_PER_PIXEL))
    plan.north_arrow(1480, 140)
    return (DFH_ZONES["Anbau"][0][0], DFH_ZONES["Anbau"][0][3]), DFH_METERS_PER_PIXEL


def _draw_lorawan(plan):
    """Section of a house: cellar, ground floor (living room, bathroom), attic."""
    draw = plan.draw
    x1, y1, x2, y2 = LORAWAN_BUILDING
    ground = LORAWAN_GROUND_Y
    plan.hatch((80, ground, x2 + 300, y2 + 40), color=LINE_SOFT, spacing=18)  # soil
    draw.rectangle([x1, ground, x2, y2], fill=ROOF_FILL)
    draw.line([60, ground, x2 + 320, ground], fill=INK, width=3)
    plan.text(x2 + 140, ground - 26, "+/- 0,00", size=15, fill=INK_SOFT)
    roof_top = 150
    draw.polygon([(x1 - 40, y1), ((x1 + x2) / 2, roof_top), (x2 + 40, y1)], outline=INK, fill=ROOF_FILL, width=4)
    draw.rectangle([x1, y1, x2, y2], outline=INK, width=4)
    draw.line([x1, ground, x2, ground], fill=INK, width=4)  # ceiling of the cellar
    draw.line([750, y1, 750, ground], fill=INK, width=3)  # wall living room | bathroom
    draw.rectangle([600, ground - 110, 640, ground], fill=ROOF_FILL, outline=INK, width=2)  # door
    for label, (x, y) in LORAWAN_ROOMS.items():
        plan.text(x, y - 46, label, size=20, center=True)
    for level, y in (("DG", 380), ("EG", 610), ("KG", 860)):
        plan.text(x1 - 110, y, level, size=22, fill=INK_SOFT, center=True)
    meters_per_pixel = LORAWAN_METERS / (x2 - x1)
    plan.dimension((x1, y2 + 70), (x2, y2 + 70), _meters(x2 - x1, meters_per_pixel))
    plan.text(1280, 300, "Gebaeudeschnitt", size=22)
    plan.text(1280, 332, "LoRaWAN-Klimasensoren S1-S4", size=15, fill=INK_SOFT)
    return (x1, y2), meters_per_pixel


def _same_database(db):
    """True when `db` is just another alias of the default database (as in the
    test settings), where an account mirror would be the same row."""
    keys = ("NAME", "HOST", "PORT")
    return all(connections[db].settings_dict.get(k) == connections["default"].settings_dict.get(k) for k in keys)
