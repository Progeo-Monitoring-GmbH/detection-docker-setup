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
    DEMO_PERMISSION,
    DEMO_TOKEN_PURPOSE,
    DEMO_USERNAME,
)
from progeo.helper.project_dbs import demo_alias, is_project_alias, register_demo_db
from progeo.management.commands._base import BaseCommand
from progeo.settings import DEMO_DATABASE, UPLOAD_DIR
from progeo.v1.models import (
    Account,
    LimitedToken,
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurement,
    ProgeoMeasurePoint,
)

DEFAULT_DB = DEMO_DATABASE
TOKEN_LIFETIME = datetime.timedelta(days=3650)

MEASUREMENT_COUNT = 48  # hourly, ending now
HOTSPOT_RISE_COUNT = 14  # the hotspot ramps up over the newest measurements
BASE_LEVEL = 500

CLIMATE_DAYS = 7
CLIMATE_STEP_HOURS = 2

PLAN_SIZE = (1000, 700)
TYPES = ProgeoLocation.PROJECT_TYPE_CHOICES


def _grid_points(columns, rows):
    """Evenly spread points: (name, nx, ny, grid_x, grid_y)."""
    return [
        (None, 0.1 + 0.8 * (col + 0.5) / columns, 0.1 + 0.8 * (row + 0.5) / rows, col, row)
        for row in range(rows)
        for col in range(columns)
    ]


def _zone_points(zones):
    """One horizontal run of sensors per zone: zones = [(name, y, x_from, x_to, count)]."""
    points = []
    for name, y, x_from, x_to, count in zones:
        for index in range(count):
            nx = x_from + (x_to - x_from) * (index / max(count - 1, 1))
            points.append((name, nx, y, index, len(points)))
    return points


DFH_ZONES = [
    ("Hauptdach", 0.3, 0.12, 0.88, 6),
    ("Anbau", 0.7, 0.1, 0.45, 4),
    ("Garage", 0.7, 0.6, 0.9, 4),
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
        "points": _grid_points(5, 4),
        "hotspot": 7,
    },
    {
        "kind": "dfh",
        "name": "Demo Dachsanierung (DFH)",
        "project_type": TYPES.DFH,
        "project_id": 9002,
        "address": "Dorfweg 12",
        "city": "Beispieldorf",
        "points": _zone_points(DFH_ZONES),
        "hotspot": 3,
    },
    {
        "kind": "lorawan",
        "name": "Demo Gebaeude (LoRaWAN)",
        "project_type": TYPES.LORAWAN,
        "project_id": 9003,
        "address": "Sensorallee 3",
        "city": "Funkstadt",
        "sensors": ["Keller", "Wohnzimmer", "Dachboden", "Bad"],
    },
]


class Command(BaseCommand):
    help = (
        "Create (or reset) the demo account used by the public demo view: an Account with "
        "a 'demo' user (only the module_demo_enabled permission), a LimitedToken for the demo "
        "link and one demo location per device type (smartex, DFH, LoRaWAN) with devices, "
        "generated measurements/alarms and a Lageplan image. The locations live in a separate "
        "database (default: settings.DEMO_DATABASE, 'demo'), so the demo never touches real customer data.\n"
        "Re-running resets the demo locations and shifts the timestamps to 'now'; account, user "
        "and token stay, so existing demo links keep working.\n\n"
        "Examples:\n"
        "  python manage.py demo_account\n"
        "  python manage.py demo_account --rotate-token\n"
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
            help="Remove everything (locations, plans, token, user and account) without recreating it.",
        )
        parser.add_argument(
            "--rotate-token",
            action="store_true",
            help="Replace the demo token, which invalidates every demo link handed out so far.",
        )
        parser.add_argument(
            "--seed",
            type=int,
            default=1,
            help="Seed of the generated sensor noise (default: 1).",
        )

    def handle(self, *args, **options):
        db = options["database"]
        if db == "default" or is_project_alias(db):
            raise CommandError(f"The demo data must not live in '{db}' (default or a project database).")
        if db == demo_alias():
            register_demo_db(create=True)  # created + migrated on the first run
        if db not in connections.databases:
            raise CommandError(f"Unknown database '{db}'. Configured: {', '.join(connections.databases)}")

        with transaction.atomic(using="default"), transaction.atomic(using=db):
            account = Account.objects.using("default").filter(raw_hash=DEMO_ACCOUNT_HASH).first()
            if account is not None:
                self._remove_locations(account, db)

            if options["delete"]:
                self._remove_account(account, db)
                self.stdout.write(self.style.SUCCESS(f"Demo account removed from '{db}'."))
                return

            account = self._ensure_account(account, db)
            user = self._ensure_user(account)
            token = self._ensure_token(account, user, options["rotate_token"])

            rng = random.Random(options["seed"])
            created = [self._create_location(account, db, spec, rng) for spec in LOCATIONS]

        summary = ", ".join(f"{spec['kind']}={location.pk}" for spec, location in zip(LOCATIONS, created))
        self.stdout.write(
            self.style.SUCCESS(f"Demo account ready: db={db}, account_id={account.pk}, locations: {summary}")
        )
        self.stdout.write(f"Demo link: /demo/login/{token.raw_hash}")

    # ------------------------------------------------------------------ cleanup

    def _remove_locations(self, account, db):
        """Delete the demo locations; the cascade takes devices, measurements,
        points, alarms and plan rows along. Plan files are removed as well."""
        ProgeoLocation.objects.using(db).filter(account_id=account.pk).delete()
        plan_dir = os.path.join(UPLOAD_DIR, os.path.dirname(DEMO_LAGEPLAN_PREFIX_REL))
        if os.path.isdir(plan_dir):
            prefix = os.path.basename(DEMO_LAGEPLAN_PREFIX_REL)
            for name in os.listdir(plan_dir):
                if name.startswith(prefix):
                    os.remove(os.path.join(plan_dir, name))

    def _remove_account(self, account, db):
        if account is None:
            return
        # The token cascades with the account; the user is only ever the demo user.
        User.objects.using("default").filter(username=DEMO_USERNAME, accounts=account).delete()
        Account.objects.using(db).filter(pk=account.pk, raw_hash=DEMO_ACCOUNT_HASH).delete()
        Account.objects.using("default").filter(pk=account.pk).delete()

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
        demo permission - and nothing else."""
        user, _ = User.objects.using("default").get_or_create(
            username=DEMO_USERNAME, defaults={"is_staff": False, "is_superuser": False}
        )
        user.is_staff = False
        user.is_superuser = False
        user.is_active = True
        user.set_unusable_password()
        user.save(using="default")

        permission = Permission.objects.using("default").filter(
            content_type__app_label="progeo", codename=DEMO_PERMISSION
        ).first()
        if permission is None:
            raise CommandError(f"Permission '{DEMO_PERMISSION}' is missing - run 'manage.py migrate' first.")
        user.user_permissions.set([permission])
        user.groups.clear()
        account.users.add(user)
        return user

    def _ensure_token(self, account, user, rotate):
        tokens = LimitedToken.objects.using("default").filter(account=account, purpose=DEMO_TOKEN_PURPOSE)
        if rotate:
            tokens.delete()
        token = tokens.first()
        valid_until = timezone.now() + TOKEN_LIFETIME
        if token is None:
            return LimitedToken.objects.using("default").create(
                raw_hash=secrets.token_urlsafe(32),
                raw_data={},
                user_id=user.pk,
                account_id=account.pk,
                purpose=DEMO_TOKEN_PURPOSE,
                valid_until=valid_until,
            )
        token.user_id = user.pk
        token.disabled = False
        token.valid_until = valid_until
        token.save(using="default")
        return token

    # --------------------------------------------------------------- locations

    def _create_location(self, account, db, spec, rng):
        location = ProgeoLocation.objects.using(db).create(
            account=account,
            name=spec["name"],
            address=spec["address"],
            plz="12345",
            city=spec["city"],
            country="Deutschland",
            manager="Max Mustermann",
            contact_person="Erika Mustermann",
            latitude=52.52,
            longitude=13.405,
            project_id=spec["project_id"],
            project_type=spec["project_type"],
        )
        plan = self._create_lageplan(location, db, spec)
        if spec["project_type"] == TYPES.LORAWAN:
            self._create_climate_data(location, db, spec, rng)
        else:
            device = self._create_device(location, db, f"demo-device-{spec['kind']}", f"Demo-Device {spec['kind']}")
            self._create_points(location, plan, db, spec["points"])
            measurements = self._create_measurements(device, db, rng, len(spec["points"]), spec["hotspot"])
            self._create_alarm(measurements, location, db, spec["hotspot"])
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
        ProgeoMeasurePoint.objects.using(db).bulk_create(
            ProgeoMeasurePoint(
                location=location,
                lageplan=plan,
                name=name,
                sensor_order=order,
                x=nx * PLAN_SIZE[0],
                y=ny * PLAN_SIZE[1],
                nx=nx,
                ny=ny,
                grid_x=grid_x,
                grid_y=grid_y,
                threshold=location.alarm_threshold,
            )
            for order, (name, nx, ny, grid_x, grid_y) in enumerate(points, start=1)
        )

    def _sensor_values(self, step, rng, count, hotspot):
        """Sensor values (pair differences) of one measurement; `step` counts
        from the oldest (0) to the newest (MEASUREMENT_COUNT - 1)."""
        values = [rng.randint(5, 45) for _ in range(count)]
        rise_start = MEASUREMENT_COUNT - HOTSPOT_RISE_COUNT
        if step >= rise_start:
            progress = (step - rise_start + 1) / HOTSPOT_RISE_COUNT
            values[hotspot - 1] = int(40 + progress * 260)
            # Neighbouring sensors pick up part of the spreading moisture.
            for neighbour in (hotspot - 2, hotspot):
                if 0 <= neighbour < count:
                    values[neighbour] += int(progress * 60)
        return values

    def _create_measurements(self, device, db, rng, count, hotspot):
        now = timezone.now()
        measurements = []
        for step in range(MEASUREMENT_COUNT):
            fetched = now - datetime.timedelta(hours=MEASUREMENT_COUNT - 1 - step)
            values = self._sensor_values(step, rng, count, hotspot)
            measurements.append(
                ProgeoMeasurement(
                    device=device,
                    project_id=device.project_id,
                    temperature=round(rng.uniform(14, 22), 1),
                    humidity=round(rng.uniform(40, 65), 1),
                    eigenpotenzial=[BASE_LEVEL] * len(values),
                    wirkpotenzial=[BASE_LEVEL + value for value in values],
                    raw_data={},
                    last_fetched=fetched,
                    last_updated=fetched,
                )
            )
        # bulk_create skips save(), which would overwrite last_fetched with now.
        return ProgeoMeasurement.objects.using(db).bulk_create(measurements)

    def _create_climate_data(self, location, db, spec, rng):
        """LoRaWAN sensors only report humidity/temperature/battery (no samples)."""
        now = timezone.now()
        steps = CLIMATE_DAYS * 24 // CLIMATE_STEP_HOURS
        measurements = []
        for number, label in enumerate(spec["sensors"], start=1):
            device = self._create_device(
                location, db, f"DEMO{location.project_id}{number:04d}", label, ProgeoDevice.DeviceType.LORAWAN
            )
            device.hardware = f"{location.project_id}_S{number}"
            device.save(using=db)
            for step in range(steps):
                fetched = now - datetime.timedelta(hours=(steps - 1 - step) * CLIMATE_STEP_HOURS)
                daily = math.sin(2 * math.pi * fetched.hour / 24)
                humidity = 48 + 4 * number + 4 * daily + rng.uniform(-1.5, 1.5)
                if label == "Keller":
                    humidity += 25 * step / steps  # a slowly getting damp cellar
                measurements.append(
                    ProgeoMeasurement(
                        device=device,
                        project_id=location.project_id,
                        temperature=round(18 + number - 3 * daily + rng.uniform(-0.5, 0.5), 1),
                        humidity=round(min(humidity, 95), 1),
                        battery=round(100 - 2 * number - 10 * step / steps, 1),  # slowly draining
                        raw_data={},
                        last_fetched=fetched,
                        last_updated=fetched,
                    )
                )
        ProgeoMeasurement.objects.using(db).bulk_create(measurements)

    def _create_alarm(self, measurements, location, db, hotspot):
        threshold = location.alarm_threshold
        over = []
        for measurement in measurements:
            value = measurement.get_pairs()[hotspot - 1]
            if value > threshold:
                over.append((measurement, value))
        if not over:
            return

        first, _ = over[0]
        last, _ = over[-1]
        peak = max(value for _, value in over)
        ProgeoAlarm.objects.using(db).create(
            measurement=last,
            triggered_at=first.last_fetched,
            still_active_at=last.last_fetched,
            threshold=threshold,
            sensor_id=hotspot,
            max_value=peak,
            sensor_max_values=[{"sensor_id": hotspot, "max_value": peak}],
            max_values=[
                {"ts": m.last_fetched.isoformat(), "value": float(v), "sensor_id": hotspot}
                for m, v in over
            ],
            status=ProgeoAlarm.Status.NEU,
        )

    # ---------------------------------------------------------------- lageplan

    def _create_lageplan(self, location, db, spec):
        """A generated site plan, stored like an upload but under the demo_
        prefix the media view allows demo users to fetch."""
        from io import BytesIO

        from PIL import Image, ImageDraw

        width, height = PLAN_SIZE
        image = Image.new("RGB", PLAN_SIZE, "#f4f1ea")
        draw = ImageDraw.Draw(image)
        draw.rectangle([40, 40, width - 40, height - 40], outline="#8b8383", width=6, fill="#ffffff")

        if spec["project_type"] == TYPES.DFH:
            for name, y, x_from, x_to, _count in DFH_ZONES:
                draw.rectangle(
                    [(x_from - 0.05) * width, (y - 0.15) * height, (x_to + 0.05) * width, (y + 0.15) * height],
                    outline="#c9c3b8",
                    width=3,
                    fill="#faf8f3",
                )
                draw.text(((x_from - 0.03) * width, (y - 0.13) * height), name, fill="#8b8383")
        else:
            for index in range(1, 5):
                x = 40 + index * (width - 80) / 5
                draw.line([x, 40, x, height - 40], fill="#e3ded3", width=3)
            draw.line([40, height / 2, width - 40, height / 2], fill="#e3ded3", width=3)
        draw.text((60, 52), f"{spec['name']} - Demo", fill="#8b8383")

        buffer = BytesIO()
        image.save(buffer, format="PNG")

        os.makedirs(os.path.join(UPLOAD_DIR, os.path.dirname(DEMO_LAGEPLAN_PREFIX_REL)), exist_ok=True)
        stored = FileSystemStorage(location=UPLOAD_DIR).save(
            f"{DEMO_LAGEPLAN_PREFIX_REL}{spec['kind']}.png", _named(buffer.getvalue(), f"{spec['kind']}.png")
        )
        return ProgeoLageplan.objects.using(db).create(
            location=location, lageplan=stored, name=f"{spec['name']} (Demo)", is_active=True
        )


def _same_database(db):
    """True when `db` is just another alias of the default database (as in the
    test settings), where an account mirror would be the same row."""
    keys = ("NAME", "HOST", "PORT")
    return all(connections[db].settings_dict.get(k) == connections["default"].settings_dict.get(k) for k in keys)


def _named(data, name):
    from django.core.files.base import ContentFile

    return ContentFile(data, name=name)
