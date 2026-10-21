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
    ProgeoAlarm,
    ProgeoDevice,
    ProgeoLageplan,
    ProgeoLocation,
    ProgeoMeasurement,
    ProgeoMeasurePoint,
)

DEFAULT_DB = DEMO_DATABASE
TOKEN_LIFETIME = datetime.timedelta(days=3650)

HISTORY_DAYS = 90  # measurements of the last ~3 months, hourly, ending now
BASE_LEVEL = 500  # eigenpotenzial; wirkpotenzial = eigen + sensor value
# Over-threshold measurements closer than this belong to one alarm (the demo
# noise must not split a moisture event into several alarms).
ALARM_MERGE_GAP = datetime.timedelta(hours=6)
LORAWAN_PACKET_LOSS = 0.015  # share of hourly LoRaWAN uplinks that never arrive

PLAN_SIZE = (1600, 1200)
TYPES = ProgeoLocation.PROJECT_TYPE_CHOICES

PAPER = "#fbfaf6"
INK = "#3d4a57"
INK_SOFT = "#8b96a3"
LINE_SOFT = "#c9d1da"
ROOF_FILL = "#ffffff"
ZONE_FILL = "#f3f6f9"


def _grid(x_from, y_from, x_to, y_to, columns, rows, name=None):
    """Sensors evenly spread over a rectangle of the plan (pixels), row by
    row: [(name, px, py, grid_x, grid_y)]."""
    width, height = x_to - x_from, y_to - y_from
    return [
        (name, x_from + width * (col + 0.5) / columns, y_from + height * (row + 0.5) / rows, col, row)
        for row in range(rows)
        for col in range(columns)
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

# Moisture events of the pair-based demo locations. `sensor` is the centre
# (sensor_order), the neighbours pick up part of it (Gaussian over `spread`
# pixels). Times count back from now; `fall_h` None = still rising/active.
SMARTEX_EPISODES = [
    {"sensor": 7, "start_days_ago": 68, "rise_h": 10, "hold_h": 20, "fall_h": 36, "peak": 190, "spread": 120,
     "status": ProgeoAlarm.Status.GELOEST, "rain": {"before_h": 6, "duration": 9, "amount": 23.4}},
    {"sensor": 19, "start_days_ago": 31, "rise_h": 4, "hold_h": 6, "fall_h": 10, "peak": 135, "spread": 90,
     "status": ProgeoAlarm.Status.QUITTIERT},
    {"sensor": 13, "start_days_ago": 3, "rise_h": 60, "hold_h": 0, "fall_h": None, "peak": 290, "spread": 120,
     "status": ProgeoAlarm.Status.NEU},
]
DFH_EPISODES = [
    {"sensor": 11, "start_days_ago": 45, "rise_h": 8, "hold_h": 12, "fall_h": 30, "peak": 150, "spread": 110,
     "status": ProgeoAlarm.Status.GELOEST, "rain": {"before_h": 4, "duration": 6, "amount": 17.8}},
    {"sensor": 8, "start_days_ago": 2, "rise_h": 30, "hold_h": 0, "fall_h": None, "peak": 175, "spread": 110,
     "status": ProgeoAlarm.Status.NEU},
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
        "episodes": SMARTEX_EPISODES,
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
            point for name, (rect, columns, rows) in DFH_ZONES.items() for point in _grid(*rect, columns, rows, name)
        ],
        "episodes": DFH_EPISODES,
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
        "4 climate sensors), each with a drawn Lageplan, measure points on it, hourly measurements of "
        "the last 3 months and the alarms they raise. The locations live in a separate database "
        "(default: settings.DEMO_DATABASE, 'demo'), so the demo never touches real customer data.\n"
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
                self._remove_account(account, db)
                self.stdout.write(self.style.SUCCESS(f"Demo account removed from '{db}'."))
                return

            account = self._ensure_account(account, db)
            user = self._ensure_user(account)
            token = self._ensure_token(account, user, options["rotate_token"])

            rng = random.Random(options["seed"])
            now = timezone.now().replace(minute=0, second=0, microsecond=0)
            hours = options["days"] * 24
            created = [self._create_location(account, db, spec, rng, now, hours) for spec in LOCATIONS]

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
            self._create_alarms(measurements, location, db, spec["episodes"], now)
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
        """Hourly pair measurements: a dry roof (individual base level, noise,
        a small daily swing) plus the moisture events of spec["episodes"]."""
        points = spec["points"]
        episodes = spec["episodes"]
        base = [rng.uniform(12, 32) for _ in points]
        eigen = [BASE_LEVEL + rng.randint(-25, 25) for _ in points]
        gains = [[_spread_gain(points, episode, index) for index in range(len(points))] for episode in episodes]

        measurements = []
        for hours_ago in range(hours - 1, -1, -1):
            fetched = now - datetime.timedelta(hours=hours_ago) + datetime.timedelta(seconds=rng.randint(0, 90))
            daily = math.sin(2 * math.pi * (fetched.hour - 9) / 24)
            season = hours_ago / max(hours - 1, 1)  # 1 = oldest (summer), 0 = now
            levels = [_episode_level(episode, hours_ago) for episode in episodes]
            wet = sum(_rain_wetness(episode, hours_ago) for episode in episodes)

            values = []
            for index in range(len(points)):
                value = base[index] + 4 * daily + 6 * wet + rng.gauss(0, 3)
                value += sum(episode["peak"] * level * gain[index]
                             for episode, level, gain in zip(episodes, levels, gains))
                values.append(max(0, round(value)))

            measurements.append(
                ProgeoMeasurement(
                    device=device,
                    project_id=device.project_id,
                    temperature=round(13 + 9 * season + 4 * daily + rng.uniform(-0.4, 0.4), 1),
                    humidity=round(min(98, 62 - 10 * season - 8 * daily + 15 * wet + rng.uniform(-2, 2)), 1),
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

    def _create_alarms(self, measurements, location, db, episodes, now):
        """One alarm per moisture event, derived from the generated values the
        way the alarm evaluation does it: over-threshold measurements of the
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
            episode = _episode_at(episodes, first.last_fetched, last.last_fetched, now) or {}
            status = episode.get("status", ProgeoAlarm.Status.NEU)
            if event["normalized_at"] is None and status == ProgeoAlarm.Status.GELOEST:
                status = ProgeoAlarm.Status.NEU  # still active, can't be resolved
            elif event["normalized_at"] is not None and status == ProgeoAlarm.Status.NEU:
                status = ProgeoAlarm.Status.GELOEST  # normalized, never acknowledged
            rain = episode.get("rain")
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
        """LoRaWAN sensors only report humidity/temperature/battery (no
        samples): late summer into autumn, a cellar getting damp over the last
        three weeks, showers in the bathroom, and the odd lost uplink."""
        measurements = []
        devices = []
        for number, (label, *_position) in enumerate(spec["points"], start=1):
            device = self._create_device(
                location, db, f"DEMO{location.project_id}{number:04d}", label, ProgeoDevice.DeviceType.LORAWAN
            )
            device.hardware = f"{location.project_id}_S{number}"
            device.save(using=db)
            devices.append((device, label, rng.uniform(0, 3)))

        for hours_ago in range(hours - 1, -1, -1):
            hour_start = now - datetime.timedelta(hours=hours_ago)
            season = hours_ago / max(hours - 1, 1)  # 1 = oldest (summer), 0 = now
            daily = math.sin(2 * math.pi * (hour_start.hour - 9) / 24)
            for device, label, drift in devices:
                if rng.random() < LORAWAN_PACKET_LOSS:
                    continue
                temperature, humidity = _room_climate(label, season, daily, hour_start.hour, hours_ago)
                drain = {"Dachboden": 27}.get(label, 12)  # heat drains the attic sensor's battery faster
                fetched = hour_start + datetime.timedelta(minutes=device.pk % 50, seconds=rng.randint(0, 59))
                measurements.append(
                    ProgeoMeasurement(
                        device=device,
                        project_id=location.project_id,
                        temperature=round(temperature + rng.uniform(-0.3, 0.3), 1),
                        humidity=round(min(99, max(5, humidity + rng.uniform(-1.2, 1.2))), 1),
                        battery=round(100 - drift - drain * (1 - season), 1),
                        raw_data={},
                        last_fetched=fetched,
                        last_updated=fetched,
                    )
                )
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


def _episode_level(episode, hours_ago):
    """0..1: how far the moisture event has developed `hours_ago` hours before now."""
    elapsed = episode["start_days_ago"] * 24 - hours_ago
    if elapsed < 0:
        return 0.0
    rise, hold, fall = episode["rise_h"], episode["hold_h"], episode["fall_h"]
    if elapsed < rise:
        return _smooth(elapsed / rise)
    if fall is None or elapsed < rise + hold:
        return 1.0
    return 1.0 - _smooth((elapsed - rise - hold) / fall)


def _rain_wetness(episode, hours_ago):
    """0..1: the whole roof is a bit wetter for a day after the episode's rain."""
    rain = episode.get("rain")
    if not rain:
        return 0.0
    since_rain = (episode["start_days_ago"] * 24 + rain["before_h"]) - hours_ago
    if since_rain < 0 or since_rain > 30:
        return 0.0
    return min(1.0, since_rain / 3) * (1 - since_rain / 30)


def _spread_gain(points, episode, index):
    """Share of the event's peak that reaches sensor `index` (Gaussian over the plan distance)."""
    _name, cx, cy, *_ = points[episode["sensor"] - 1]
    _name, px, py, *_ = points[index]
    distance = math.hypot(px - cx, py - cy)
    return math.exp(-(distance**2) / (2 * episode["spread"] ** 2))


def _episode_at(episodes, start, end, now):
    """The configured episode that began around [start, end] (within a week)."""

    def distance(episode):
        began = now - datetime.timedelta(days=episode["start_days_ago"])
        if start - datetime.timedelta(hours=12) <= began <= end:
            return 0
        return abs((began - start).total_seconds())

    best = min(episodes, key=distance, default=None)
    if best is None or distance(best) > 7 * 24 * 3600:
        return None
    return best


def _room_climate(label, season, daily, hour, hours_ago):
    """(temperature, humidity) of a room; season 1 = late summer, 0 = now."""
    if label == "Keller":
        damp = _smooth(1 - hours_ago / (21 * 24)) * 18  # rising over the last three weeks
        return 13.5 + 3.5 * season + 0.3 * daily, 62 + 3 * season + damp
    if label == "Wohnzimmer":
        return 21 + 2.5 * season + 1.2 * daily, 47 + 8 * season - 2 * daily
    if label == "Dachboden":
        temperature = 12 + 16 * season + 5 * daily
        return temperature, 72 - 0.9 * temperature
    # Bad: showers in the morning and the evening.
    shower = max(0, 1 - abs(hour - 7) / 2) + max(0, 1 - abs(hour - 21) / 2)
    return 21.5 + 1 * season + 0.6 * daily + 1.5 * shower, 58 + 4 * season + 28 * shower


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
